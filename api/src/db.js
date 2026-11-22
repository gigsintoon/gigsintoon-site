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
const { isOwner, isRunner, markRunner } = require('./auth');
const crypto = require('crypto');

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
const DAILY = ['week', 'stats', 'sitemap', 'search', 'roundup/{date}'];
// links only change when Micky saves something, so they don't need rebuilding every day
const ON_CHANGE = ['venue', 'bands/{id:int}', 'gigs/{id:int}', 'links'];   // only rebuilt when something is saved
const cacheKey = (route, r) => route.replace(/[{}:?]/g, '') + '?' + [...Object.entries(r.params || {}), ...[...r.query.entries()].sort()]
  .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join('&');

async function cachedCall(name, route, handler, request, context) {
  const stampFn = STAMPS[route] || (DAILY.includes(route) ? () => ukDay() : ON_CHANGE.includes(route) ? () => 'c' : null);
  if (!stampFn || request.method !== 'GET') return handler(request, context);
  const runner = isRunner(request);
  let k, stamp;
  try {
    k = cacheKey(route, request);
    const v = await store.versions();
    // a day's page only depends on its own day; everything else on the list version
    const part = route === 'onthisday' ? (v.d[`${pad(request.query.get('month'))}-${pad(request.query.get('day'))}`] || '0') : v.l;
    stamp = v.g + '|' + part + '|' + stampFn(request);
  } catch (err) { context.warn('cache read failed: ' + err.message); }
  // The owner browsing the public pages sees the same ready-made answers as visitors (from the last overnight run).
  if (isOwner(request) && !runner) {
    const have = k ? await store.getStale(k).catch(() => undefined) : undefined;
    if (have !== undefined) return { status: 200, jsonBody: have, headers: { 'Cache-Control': 'no-store', 'X-Cache': 'owner-saved' } };
    return handler(request, context);     // nothing saved yet: live (this is the only case that wakes the database)
  }
  if (k && stamp) {
    const hit = await store.getCached(k, stamp).catch(() => undefined);
    if (hit !== undefined) return { status: 200, jsonBody: hit, headers: { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'hit' } };
    // Out of date: visitors get the last saved answer; only the overnight run rebuilds it (so the database wakes once a day)
    if (!runner) {
      const old = await store.getStale(k).catch(() => undefined);
      if (old !== undefined) return { status: 200, jsonBody: old, headers: { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'saved' } };
    }
  }
  // Never asked for before (or the overnight run): work it out and save it
  const res = await handler(request, context);
  if (stamp && res && (res.status || 200) === 200 && res.jsonBody !== undefined) {
    await store.setCached(k, stamp, res.jsonBody, pathOf(request)).catch(err => context.warn('cache write failed: ' + err.message));
    res.headers = { ...(res.headers || {}), 'Cache-Control': 'public, max-age=300', 'X-Cache': 'miss' };
  }
  return res;
}
const pathOf = request => { try { const u = new URL(request.url); return u.pathname + u.search; } catch { return null; } };

// The overnight run proves who it is with the weekly-report key (only its hash is stored)
let keyHash = null;
async function checkRunner(request) {
  const got = request.headers.get('x-report-key');
  if (!got) return false;
  if (!keyHash) keyHash = await store.getStale('runner-keyhash').catch(() => undefined) || null;
  if (!keyHash) {
    const row = await query(`SELECT Value FROM music.Settings WHERE Name = N'ReportKeyHash'`);
    keyHash = row[0] ? row[0].Value : null;
    if (keyHash) await store.setCached('runner-keyhash', 'k', keyHash).catch(() => {});
  }
  if (!keyHash) return false;
  const want = Buffer.from(keyHash, 'hex'), h = crypto.createHash('sha256').update(got).digest();
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}
function forgetRunnerKey() { keyHash = null; return store.setCached('runner-keyhash', 'k', '').catch(() => {}); }

// Admin pages the owner reads (lists, to-dos, messages...): shown as they were at the last overnight run
const ADMIN_SNAPSHOT = ['manage/month', 'manage/todos', 'manage/messages', 'manage/bands', 'manage/site-info',
  'manage/remembering', 'manage/site-additions', 'manage/status-overrides', 'manage/import'];
// Admin saves that never touch the database: done straight away
const IMMEDIATE = ['manage/upload', 'manage/upload-link', 'manage/media-copy', 'manage/rebuild', 'manage/report-key',
  'manage/visits', 'manage/media', 'manage/unread', 'manage/queue', 'manage/nightly', 'manage/data-source', 'manage/compare'];

// Admin saves that don't change anything visitors see
const NO_BUMP = ['manage/data-source', 'manage/compare', 'manage/deezer-fill', 'manage/messages', 'manage/todos', 'manage/visits-import', 'manage/upload-link', 'manage/upload', 'manage/report-key', 'manage/queue', 'manage/nightly'];
// Saves that name releases by id (release-fix, status, release-links): look up which days those releases are on
const BY_RELEASE_ID = ['manage/release-fix', 'manage/status', 'manage/release-links'];
// Which days ("MM-DD") a save is about, from dates in its body; null = can't tell, refresh everything
async function daysIn(request, route) {
  try {
    const t = await request.clone().text();
    if (!t) return null;
    let body = JSON.parse(t);
    if (route === 'manage/release-fix' && body && Array.isArray(body.fixes)) body = body.fixes;
    const out = new Set(), ids = [];
    let unknownItem = false;
    for (const item of [].concat(body)) {
      if (!item || typeof item !== 'object') { unknownItem = true; continue; }
      const d = String(item.date || item.ReleaseDate || '');
      const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d);
      if (m) out.add(m[1] + '-' + m[2]);
      else if (item.month && item.day) out.add(pad(item.month) + '-' + pad(item.day));
      // a release named by id: its current day (if the save moves it, the new date above adds the new day too)
      if (BY_RELEASE_ID.includes(route) && Number.isInteger(item.id)) ids.push(item.id);
      else if (!m && !(item.month && item.day)) unknownItem = true;
    }
    if (ids.length && !unknownItem) {
      const rows = await query(`SELECT DISTINCT ReleaseMonth AS M, ReleaseDay AS D FROM music.Releases
                                 WHERE ReleaseId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`,
        { ids: [sql.NVarChar(sql.MAX), JSON.stringify(ids)] });
      if (rows.length < 1) return null;
      rows.forEach(r => out.add(pad(r.M) + '-' + pad(r.D)));
    }
    return out.size && !unknownItem ? [...out] : null;
  } catch { return null; }
}

// Wrap every function as it's registered:
//  - the overnight run (report key) is recognised and acts as the owner
//  - public GETs go through the ready-made answers
//  - owner admin reads come from the last overnight run; owner saves wait in a queue for the overnight run
//    (add ?now=1 to save straight away, which wakes the database)
const handlers = {};    // route -> wrapped handler, so the overnight run can call admin routes directly
const rawHandlers = {}; // route -> the handler itself (for the side-by-side check, GET /api/manage/compare)
if (!app.__gigsWrapped) {
  const orig = app.http.bind(app);
  app.http = (name, opts) => {
    const route = opts.route || name, handler = opts.handler;
    rawHandlers[route] = handler;
    return orig(name, { ...opts, handler: handlers[route] = async (request, context) => {
      if (request.headers.get('x-report-key') && await checkRunner(request).catch(() => false)) markRunner(request, route.startsWith('manage/'));
      const runner = isRunner(request);
      if (route.startsWith('manage/') && request.method !== 'GET') {
        if (isOwner(request) && !runner && !IMMEDIATE.includes(route) && request.query.get('now') !== '1') {
          const body = await request.text();
          const u = new URL(request.url);
          await store.queueAdd({ route, method: request.method, path: u.pathname + u.search, body });
          return { status: 202, jsonBody: { ok: true, queued: true, note: 'Saved - it goes into the database in the overnight run (add ?now=1 to do it straight away).' } };
        }
        const days = await daysIn(request, route);
        const res = await handler(request, context);
        // a save that reached the database: the storage copy is out of date until the next overnight copy
        if (!IMMEDIATE.includes(route) && res && (res.status || 200) < 400) await require('./catalogue').noteChange().catch(err => context.warn('change note failed: ' + err.message));
        if (route === 'manage/report-key') await forgetRunnerKey();
        if (res && (res.status || 200) < 400 && isOwner(request) && !NO_BUMP.includes(route)) {
          await store.bumpVersion({ days }).catch(err => context.warn('version bump failed: ' + err.message));
        }
        return res;
      }
      if (route.startsWith('manage/') && request.method === 'GET' && ADMIN_SNAPSHOT.includes(route) && isOwner(request)) {
        const k = 'admin-' + cacheKey(route, request);
        if (!runner && request.query.get('now') !== '1') {
          const have = await store.getStale(k).catch(() => undefined);
          if (have !== undefined) return { status: 200, jsonBody: have, headers: { 'Cache-Control': 'no-store', 'X-Cache': 'last-overnight-run' } };
        }
        const res = await handler(request, context);
        if (res && (res.status || 200) === 200 && res.jsonBody !== undefined) await store.setCached(k, 's', res.jsonBody, pathOf(request)).catch(() => {});
        return res;
      }
      return cachedCall(name, route, handler, request, context);
    } });
  };
  app.__gigsWrapped = true;
}

// Run a route's handler as the overnight run (as the owner), without going through the web address
// (the /api/manage/* addresses only let a signed-in owner in).
async function runAsOwner(route, method, path, body, context) {
  const h = handlers[route];
  if (!h) return { status: 404, jsonBody: { error: 'No such route: ' + route } };
  const u = new URL(path, 'https://www.gigsintoon.co.uk');
  const req = { method, url: u.href, query: u.searchParams, params: {}, user: null,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => body || '', json: async () => JSON.parse(body || 'null'),
    arrayBuffer: async () => Buffer.from(body || ''), clone() { return req; } };
  markRunner(req, true);
  return h(req, context);
}

module.exports = { sql, query, json, fail, ukDay, runAsOwner, rawHandlers };
