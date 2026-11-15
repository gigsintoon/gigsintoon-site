const sql = require('mssql');

let poolPromise;
function getPool() {
  if (!poolPromise) {
    const cs = process.env.SQL_CONNECTION_STRING;
    if (!cs) throw new Error('SQL_CONNECTION_STRING is not set');
    poolPromise = new sql.ConnectionPool(cs).connect().catch(err => {
      poolPromise = undefined;
      throw err;
    });
  }
  return poolPromise;
}

async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, [type, value]] of Object.entries(params)) req.input(name, type, value);
  const result = await req.query(text);
  return result.recordset;
}

function json(body, status = 200) {
  return { status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } };
}

function fail(context, err) {
  context.error(err);
  return json({ error: 'Something went wrong talking to the database.' }, 500);
}

// ---------------------------------------------------------------------------------------------
// Ready-made answers for visitors. The SQL database pauses after an hour without use and every wake-up
// costs (and makes the first visitor wait), so public GET answers are kept in blob storage and only
// rebuilt when something changes:
//   - the data version (bumped whenever Micky saves anything in the admin pages, or via POST /api/manage/rebuild)
//   - and, where an answer depends on the date, the part of the date it depends on.
// Micky (owner) always gets live answers. Nothing here changes what a visitor sees - only where it comes from.
const { app } = require('@azure/functions');
const store = require('./store');
const { isOwner } = require('./auth');

const ukDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const pad = n => String(n).padStart(2, '0');
// How an answer depends on the date
const STAMPS = {
  // a day's page only changes when that day arrives (releases become visible) or the year turns
  onthisday: r => { const t = ukDay(); const md = `${pad(r.query.get('month'))}-${pad(r.query.get('day'))}`;
                    return t.slice(0, 4) + '|' + (md < t.slice(5) ? 'past' : md === t.slice(5) ? 'today' : 'future'); },
  favourites: () => ukDay().slice(0, 4),
  'years/{year:int?}': r => (r.params.year && Number(r.params.year) < Number(ukDay().slice(0, 4))) ? 'old' : ukDay(),
};
const DAILY = ['week', 'stats', 'sitemap', 'search', 'links', 'roundup/{date}'];
const ON_CHANGE = ['venue', 'bands/{id:int}', 'gigs/{id:int}'];   // only rebuilt when something is saved
const cacheKey = (route, r) => route.replace(/[{}:?]/g, '') + '?' + [...Object.entries(r.params || {}), ...[...r.query.entries()].sort()]
  .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join('&');

async function cachedCall(name, route, handler, request, context) {
  const stampFn = STAMPS[route] || (DAILY.includes(route) ? () => ukDay() : ON_CHANGE.includes(route) ? () => 'c' : null);
  if (!stampFn || request.method !== 'GET' || isOwner(request)) return handler(request, context);
  let k, stamp;
  try {
    k = cacheKey(route, request);
    const v = await store.versions();
    // a day's page only depends on its own day; everything else on the list version
    const part = route === 'onthisday' ? (v.d[`${pad(request.query.get('month'))}-${pad(request.query.get('day'))}`] || '0') : v.l;
    stamp = v.g + '|' + part + '|' + stampFn(request);
    const hit = await store.getCached(k, stamp);
    if (hit !== undefined) return { status: 200, jsonBody: hit, headers: { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'hit' } };
  } catch (err) { context.warn('cache read failed: ' + err.message); }
  const res = await handler(request, context);
  if (stamp && res && (res.status || 200) === 200 && res.jsonBody !== undefined) {
    await store.setCached(k, stamp, res.jsonBody).catch(err => context.warn('cache write failed: ' + err.message));
    res.headers = { ...(res.headers || {}), 'Cache-Control': 'public, max-age=300', 'X-Cache': 'miss' };
  }
  return res;
}

// Admin saves that don't change anything visitors see
const NO_BUMP = ['manage/deezer-fill', 'manage/messages', 'manage/todos', 'manage/visits-import', 'manage/upload-link', 'manage/upload', 'manage/report-key'];
// Which days ("MM-DD") a save is about, from dates in its body; null = can't tell, refresh everything
async function daysIn(request) {
  try {
    const t = await request.clone().text();
    if (!t) return null;
    const body = JSON.parse(t), out = new Set();
    let unknownItem = false;
    for (const item of [].concat(body)) {
      if (!item || typeof item !== 'object') { unknownItem = true; continue; }
      const d = String(item.date || item.ReleaseDate || '');
      const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d);
      if (m) out.add(m[1] + '-' + m[2]);
      else if (item.month && item.day) out.add(pad(item.month) + '-' + pad(item.day));
      else unknownItem = true;
    }
    return out.size && !unknownItem ? [...out] : null;
  } catch { return null; }
}
// After a save the database is awake anyway: refresh the busiest ready-made pages straight away
async function rewarm(days) {
  const t = ukDay(), [y, mm, dd] = t.split('-');
  const urls = ['/api/week', '/api/favourites', '/api/stats', '/api/years', `/api/years/${y}`, '/api/search?all=1', `/api/onthisday?month=${+mm}&day=${+dd}`]
    .concat((days || []).slice(0, 6).map(d => `/api/onthisday?month=${+d.slice(0, 2)}&day=${+d.slice(3)}`));
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), 8000);
  await Promise.allSettled([...new Set(urls)].map(u => fetch('https://www.gigsintoon.co.uk' + u, { signal: c.signal })));
  clearTimeout(timer);
}

// Wrap every function as it's registered: public GETs go through the cache; any successful admin save bumps the data version.
if (!app.__gigsWrapped) {
  const orig = app.http.bind(app);
  app.http = (name, opts) => {
    const route = opts.route || name, handler = opts.handler;
    return orig(name, { ...opts, handler: async (request, context) => {
      if (route.startsWith('manage/') && request.method !== 'GET') {
        const days = await daysIn(request);
        const res = await handler(request, context);
        if (res && (res.status || 200) < 400 && isOwner(request) && !NO_BUMP.includes(route)) {
          await store.bumpVersion({ days }).catch(err => context.warn('version bump failed: ' + err.message));
          await rewarm(days);
        }
        return res;
      }
      return cachedCall(name, route, handler, request, context);
    } });
  };
  app.__gigsWrapped = true;
}

module.exports = { sql, query, json, fail, ukDay };
