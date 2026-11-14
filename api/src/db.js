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
const DAILY = ['week', 'stats', 'sitemap', 'search', 'links', 'venue', 'bands/{id:int}', 'gigs/{id:int}', 'roundup/{date}'];
const cacheKey = (route, r) => route.replace(/[{}:?]/g, '') + '?' + [...Object.entries(r.params || {}), ...[...r.query.entries()].sort()]
  .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join('&');

async function cachedCall(name, route, handler, request, context) {
  const stampFn = STAMPS[route] || (DAILY.includes(route) ? () => ukDay() : null);
  if (!stampFn || request.method !== 'GET' || isOwner(request)) return handler(request, context);
  let k, stamp;
  try {
    k = cacheKey(route, request);
    stamp = (await store.dataVersion()) + '|' + stampFn(request);
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

// Wrap every function as it's registered: public GETs go through the cache; any successful admin save bumps the data version.
if (!app.__gigsWrapped) {
  const orig = app.http.bind(app);
  app.http = (name, opts) => {
    const route = opts.route || name, handler = opts.handler;
    return orig(name, { ...opts, handler: async (request, context) => {
      if (route.startsWith('manage/') && request.method !== 'GET') {
        const res = await handler(request, context);
        if (res && (res.status || 200) < 400 && isOwner(request)) await store.bumpVersion().catch(err => context.warn('version bump failed: ' + err.message));
        return res;
      }
      return cachedCall(name, route, handler, request, context);
    } });
  };
  app.__gigsWrapped = true;
}

module.exports = { sql, query, json, fail, ukDay };
