// Moving off SQL, step 2: the side-by-side check and the switch.
//
//   GET  /api/manage/compare?path=/api/onthisday?month=11&day=22   (owner)  one page, answered from SQL and from the copy
//   GET  /api/manage/compare?all=1&offset=0&limit=40               (owner)  a batch of every page the site has
//   GET  /api/nightly/compare?...                                  (overnight run) the same
//   GET  /api/manage/data-source                                   (owner)  which source the pages use, and the copy's date
//   POST /api/manage/data-source {source: "catalogue" | "sql"}     (owner)  flips the switch (storage only, no deploy)
//
// Each page is answered as a visitor would see it. "same" = identical; "order" = the same items in a different
// order (only where the database's own order isn't fixed, e.g. two releases by the same band in the same year);
// "different" = a real difference, listed so it can be fixed before switching.
const { app } = require('@azure/functions');
const { json, fail, rawHandlers, ukDay } = require('../db');
const { isOwner, isRunner } = require('../auth');
const store = require('../store');
const cat = require('../catalogue');

// '/api/bands/12' -> { route: 'bands/{id:int}', params: { id: '12' } }
function match(path) {
  const u = new URL(path, 'https://www.gigsintoon.co.uk');
  const p = u.pathname.replace(/^\/api\//, '');
  for (const route of Object.keys(rawHandlers)) {
    const names = [];
    const re = new RegExp('^' + route.split('/').map(seg => {
      const m = /^\{(\w+)(?::\w+)?(\?)?\}$/.exec(seg);
      if (!m) return '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]);
      return m[2] ? '(?:/([^/]+))?' : '/([^/]+)';
    }).join('').slice(1) + '$');
    const mm = re.exec(p);
    if (mm) { const params = {}; names.forEach((n, i) => { if (mm[i + 1] !== undefined) params[n] = mm[i + 1]; }); return { route, params, url: u }; }
  }
  return null;
}

async function answer(path, source) {
  const m = match(path);
  if (!m) return { status: 404, error: 'no such page' };
  const req = { method: 'GET', url: m.url.href, query: m.url.searchParams, params: m.params, user: null,
    headers: new Headers({}), text: async () => '', json: async () => null, clone() { return req; } };
  cat.force(req, source);
  const ctx = { log() {}, warn() {}, error() {}, info() {} };
  const res = await rawHandlers[m.route](req, ctx);
  return { status: res.status || 200, body: res.jsonBody !== undefined ? JSON.parse(JSON.stringify(res.jsonBody)) : (typeof res.body === 'string' ? res.body : null) };
}

const canon = v => Array.isArray(v) ? v.map(canon).map(x => JSON.stringify(x)).sort().map(x => JSON.parse(x))
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const keySorted = v => Array.isArray(v) ? v.map(keySorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, keySorted(v[k])])) : v;
// where two answers first differ (a few places, values shortened)
function diffs(a, b, at = '', out = []) {
  if (out.length >= 6) return out;
  if (JSON.stringify(keySorted(a)) === JSON.stringify(keySorted(b))) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) out.push({ at, sql: `${a.length} items`, copy: `${b.length} items` });
    const keys = Array.isArray(a) ? [...Array(Math.min(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) diffs(a[k], b[k], at + (Array.isArray(a) ? `[${k}]` : '.' + k), out);
    return out;
  }
  const short = v => { const t = JSON.stringify(v); return t === undefined ? 'missing' : t.length > 140 ? t.slice(0, 140) + '…' : t; };
  out.push({ at, sql: short(a), copy: short(b) });
  return out;
}

async function compareOne(path) {
  try {
    const [a, b] = [await answer(path, 'sql'), await answer(path, 'catalogue')];
    if (a.status !== b.status) return { path, result: 'different', diffs: [{ at: 'status', sql: a.status, copy: b.status }] };
    let x = a.body, y = b.body;
    if (typeof x === 'string' && typeof y === 'string') { x = x.split('\n').sort(); y = y.split('\n').sort(); }   // sitemap: same lines
    if (JSON.stringify(keySorted(x)) === JSON.stringify(keySorted(y))) return { path, result: 'same' };
    if (JSON.stringify(canon(x)) === JSON.stringify(canon(y))) return { path, result: 'order', diffs: diffs(x, y).slice(0, 2) };
    return { path, result: 'different', diffs: diffs(x, y) };
  } catch (err) { return { path, result: 'error', error: err.message }; }
}

// Every page the site keeps a ready-made answer for, plus all 366 days (images and the guessing game left out:
// the game still saves its daily pick in the database until step 3, and pictures are compared via their lists)
async function allPaths() {
  const urls = new Set(await store.cachedUrls());
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= new Date(Date.UTC(2024, m, 0)).getUTCDate(); d++) urls.add(`/api/onthisday?month=${m}&day=${d}`);
  ['/api/week', '/api/favourites', '/api/stats', '/api/years', '/api/sitemap', '/api/search?all=1'].forEach(u => urls.add(u));
  return [...urls].filter(u => /^\/api\/(onthisday|week|favourites|stats|years|sitemap|search|bands|gigs|venue|links)\b/.test(u)).sort();
}

async function compareHandler(request, context) {
  if (!isOwner(request) && !isRunner(request)) return json({ error: 'Not allowed.' }, 403);
  try {
    const path = request.query.get('path');
    if (path) return json(await compareOne(path));
    const list = await allPaths();
    const offset = Math.max(0, parseInt(request.query.get('offset') || '0', 10) || 0);
    const limit = Math.min(80, Math.max(1, parseInt(request.query.get('limit') || '40', 10) || 40));
    const results = [];
    for (const p of list.slice(offset, offset + limit)) results.push(await compareOne(p));
    const count = r => results.filter(x => x.result === r).length;
    return json({ total: list.length, offset, next: offset + limit < list.length ? offset + limit : null,
      copy: (await cat.load().catch(() => ({}))).manifest || null,
      same: count('same'), order: count('order'), different: count('different'), errors: count('error'),
      problems: results.filter(x => x.result !== 'same') });
  } catch (err) { return fail(context, err); }
}
app.http('manageCompare', { methods: ['GET'], authLevel: 'anonymous', route: 'manage/compare', handler: compareHandler });
app.http('nightlyCompare', { methods: ['GET'], authLevel: 'anonymous', route: 'nightly/compare', handler: compareHandler });

app.http('manageDataSource', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/data-source',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!['sql', 'catalogue'].includes(b.source)) return json({ ok: false, error: 'Give {source: "sql" | "catalogue"}' }, 400);
        await cat.setSwitch(b.source);
      }
      const snap = await cat.load().catch(() => null);
      return json({ ok: true, source: await cat.switchSetting(), copy: snap ? snap.manifest : null, today: ukDay() });
    } catch (err) { return fail(context, err); }
  }
});
