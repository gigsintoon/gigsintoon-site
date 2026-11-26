// Vote of the week: four randomly selected albums, singles or EPs from one year of the collection.
// A new vote opens every Monday (UK time) and closes Saturday at 18:00; the result shows until the next Monday.
//
// Everything lives in the "votes" table, one partition per week (the Monday's date, e.g. 2026-11-30):
//   poll          – the four releases picked for that week (picked once, the first time anyone asks)
//   count-<id>    – votes for each release
//   voter-<id>    – one row per browser that has voted (stops the same browser voting twice)
//   ip-<hash>     – votes from one internet connection, scrambled with a secret; at most 3 a week. Deleted when the vote closes.
//
// Hidden until the owner switches it on (POST /api/manage/vote-live {live:true}); until then only the owner sees it.
const { app } = require('@azure/functions');
const crypto = require('crypto');
const store = require('../store');
const cat = require('../catalogue');
const fc = require('../fromcatalogue');
const { handlesFor } = require('../handles');
const { isOwner } = require('../auth');

const T_VOTES = 'votes';
const TYPES = ['Album', 'Single', 'EP'];
const PER_CONNECTION = 3;
const PICK = 4;
const json = (body, status = 200) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });

// ---------- UK dates ----------
const ukParts = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
};
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (day, n) => { const t = new Date(day + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// a UK wall-clock time -> the real moment (handles GMT/BST)
function ukMoment(day, hour) {
  const guess = Date.parse(day + 'T' + String(hour).padStart(2, '0') + ':00:00Z');
  const p = ukParts(new Date(guess));
  const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (shown - guess));
}
function weekOf(d = new Date()) {
  const p = ukParts(d);
  const today = iso(p.y, p.m, p.d);
  const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
  const week = addDays(today, -dow);
  const closesAt = ukMoment(addDays(week, 5), 18);
  return { week, today, closesAt, open: d < closesAt, nextOpens: ukMoment(addDays(week, 7), 0) };
}
const weekNo = week => {   // ISO week number, for "Week 48"
  const t = new Date(week + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 3);
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
};

// ---------- secrets, tokens ----------
const secret = () => crypto.createHash('sha256').update('vote|' + (process.env.STORAGE_CONNECTION_STRING || '')).digest();
const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', secret()).update(b).digest('base64url'); };
function readToken(t) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
}
const ipHash = (request, week) => {
  const ip = (request.headers.get('x-forwarded-for') || request.headers.get('x-client-ip') || '').split(',')[0].trim().replace(/:\d+$/, '');
  return crypto.createHmac('sha256', secret()).update(week + '|' + ip).digest('hex').slice(0, 32);
};

// ---------- picking the four ----------
function rng(seed) {   // small seeded generator, so a week's pick is repeatable
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
const NEVER = /^(anti-?flag|lostprophets)$/i;
function pickFor(s, week, avoid) {
  const T = fc.today();
  const thisYear = +String(week).slice(0, 4);
  const groups = new Map();   // "Album|1997" -> releases
  for (const r of s.Releases) {
    if (!TYPES.includes(r.ReleaseType) || !fc.visible(r, T) || r.ReleaseYear >= thisYear) continue;
    const b = s.bands.get(r.BandId) || {};
    if (b.NeverPost || NEVER.test(String(b.Name || '').trim())) continue;
    if (!(s.imgRel.get(r.ReleaseId) || []).length) continue;
    const k = r.ReleaseType + '|' + r.ReleaseYear;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const ok = [...groups.entries()].filter(([, l]) => new Set(l.map(r => r.BandId)).size >= PICK);
  if (!ok.length) return null;
  const rand = rng('vote|' + week);
  const fresh = ok.filter(([k]) => !avoid.has(k));
  const pool = fresh.length ? fresh : ok;
  // type first (so EPs get a fair chance), then a year with enough of that type
  const types = TYPES.filter(t => pool.some(([k]) => k.startsWith(t + '|')));
  const type = types[Math.floor(rand() * types.length)];
  const years = pool.filter(([k]) => k.startsWith(type + '|'));
  const [key, list] = years[Math.floor(rand() * years.length)];
  const shuffled = list.slice().sort((a, b) => a.ReleaseId - b.ReleaseId);
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const picked = [], bands = new Set();
  for (const r of shuffled) { if (bands.has(r.BandId)) continue; picked.push(r.ReleaseId); bands.add(r.BandId); if (picked.length === PICK) break; }
  const [t, y] = key.split('|');
  return { Type: t, Year: +y, Ids: JSON.stringify(picked.sort((a, b) => {
    const ra = s.relById.get(a), rb = s.relById.get(b); return String(ra.ReleaseDate).localeCompare(String(rb.ReleaseDate)); })) };
}
async function pollFor(s, week, create) {
  let p = await store.get(T_VOTES, week, 'poll');
  if (p || !create) return p;
  const avoid = new Set();
  for (let i = 1; i <= 12; i++) { const old = await store.get(T_VOTES, addDays(week, -7 * i), 'poll'); if (old) avoid.add(old.Type + '|' + old.Year); }
  const fresh = pickFor(s, week, avoid);
  if (!fresh) return null;
  await store.insertIfNew(T_VOTES, week, 'poll', fresh);
  return store.get(T_VOTES, week, 'poll');
}

function entries(s, poll) {
  const T = fc.today();
  const ids = JSON.parse(poll.Ids || '[]');
  const list = ids.map(id => s.relById.get(id)).filter(Boolean).map(r => {
    const x = fc.relRow(s, r, false, T);
    return { ReleaseId: x.ReleaseId, Title: x.Title, Artist: x.Artist, BandId: x.BandId, ReleaseType: x.ReleaseType,
             ReleaseYear: x.ReleaseYear, ReleaseMonth: x.ReleaseMonth, ReleaseDay: x.ReleaseDay, ChartPosition: x.ChartPosition,
             Label: x.Label, WriteUp: x.WriteUp, CoverUrl: x.CoverUrl };
  });
  return { entries: list, handles: handlesFor(fc.handleMap(s), list.map(x => x.WriteUp)) };
}
async function tally(week, ids) {
  const rows = await store.rows(T_VOTES, week);
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (const r of rows) if (r.rk.startsWith('count-')) { const id = +r.rk.slice(6); if (id in counts) counts[id] = Number(r.Votes) || 0; }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const results = ids.map(id => ({ id, votes: counts[id], pct: total ? Math.round(100 * counts[id] / total) : 0 }))
    .sort((a, b) => b.votes - a.votes);
  const top = results.length && results[0].votes ? results[0].votes : null;
  return { total, results, winners: top ? results.filter(r => r.votes === top).map(r => r.id) : [], rows };
}
// once a vote has closed, the scrambled connection rows aren't needed: delete them
async function forgetConnections(week, rows) {
  const ips = (rows || await store.rows(T_VOTES, week)).filter(r => r.rk.startsWith('ip-'));
  for (const r of ips) await store.del(T_VOTES, week, r.rk);
}

async function isLive() { const r = await store.get(T_VOTES, 'settings', 'live'); return !!(r && r.Live); }
async function allowed(request) { return isOwner(request) || await isLive(); }

// GET /api/vote            -> this week's vote (and the visitor's own vote, from their token)
// GET /api/vote?past=1     -> recent results
// POST /api/vote {id, token} -> cast a vote
app.http('vote', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'vote',
  handler: async (request, context) => {
    try {
      if (!await allowed(request)) return json({ error: 'Not available yet.' }, 404);
      const s = await cat.load();
      const now = weekOf();
      const owner = isOwner(request);

      if (request.method === 'GET' && request.query.get('past')) {
        const out = [];
        for (let i = 1; i <= 12; i++) {
          const w = addDays(now.week, -7 * i);
          const poll = await pollFor(s, w, false);
          if (!poll) continue;
          const { entries: list } = entries(s, poll);
          const t = await tally(w, list.map(x => x.ReleaseId));
          if (!t.total) continue;
          out.push({ week: w, weekNo: weekNo(w), type: poll.Type, year: poll.Year, total: t.total, results: t.results,
                     entries: list.map(x => ({ ReleaseId: x.ReleaseId, Title: x.Title, Artist: x.Artist, CoverUrl: x.CoverUrl })) , winners: t.winners });
        }
        return json({ past: out });
      }

      const poll = await pollFor(s, now.week, true);
      if (!poll) return json({ error: 'Not enough releases to pick from.' }, 500);
      const { entries: list, handles } = entries(s, poll);
      const ids = list.map(x => x.ReleaseId);

      let body = {};
      if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
      const tokenIn = body.token || request.headers.get('x-vote-token') || request.query.get('token');
      let tok = readToken(tokenIn);
      if (!tok || tok.w !== now.week) tok = { w: now.week, v: crypto.randomBytes(12).toString('base64url') };
      const token = sign(tok);
      const mine = await store.get(T_VOTES, now.week, 'voter-' + tok.v);
      let voted = mine ? Number(mine.Choice) : null;
      let message = null;

      if (request.method === 'POST') {
        const id = Number(body.id);
        if (!now.open) return json({ error: 'Voting has closed for this week.' }, 409);
        if (!ids.includes(id)) return json({ error: "That release isn't in this week's vote." }, 400);
        if (voted == null) {
          const h = 'ip-' + ipHash(request, now.week);
          const conn = await store.get(T_VOTES, now.week, h);
          if (!owner && conn && Number(conn.Votes) >= PER_CONNECTION) {
            message = "Thanks! A few votes have already come from your internet connection this week, so this one wasn't counted.";
          } else if (await store.insertIfNew(T_VOTES, now.week, 'voter-' + tok.v, { Choice: id, At: new Date().toISOString() })) {
            await store.incr(T_VOTES, now.week, h, { Votes: 1 });
            await store.incr(T_VOTES, now.week, 'count-' + id, { Votes: 1 });
            voted = id;
          } else {
            voted = Number((await store.get(T_VOTES, now.week, 'voter-' + tok.v)).Choice);
          }
        }
      }

      const showResults = voted != null || !now.open || (owner && request.query.get('results') === '1');
      const t = showResults ? await tally(now.week, ids) : null;
      if (!now.open && t && t.rows.some(r => r.rk.startsWith('ip-'))) await forgetConnections(now.week, t.rows).catch(() => {});
      return json({
        week: now.week, weekNo: weekNo(now.week), type: poll.Type, year: poll.Year,
        open: now.open, closesAt: now.closesAt.toISOString(), nextOpens: now.nextOpens.toISOString(), serverNow: new Date().toISOString(),
        entries: list, handles, token, voted, message,
        results: t ? t.results : null, total: t ? t.total : null, winners: t && !now.open ? t.winners : null,
        live: await isLive()
      });
    } catch (err) {
      context.error(err);
      return json({ error: 'Something went wrong with the vote.' }, 500);
    }
  }
});

// POST /api/manage/vote-live {live:true|false} (owner only) – show or hide the vote for visitors
app.http('voteLive', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/vote-live',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Owner only.' }, 403);
    if (request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch { b = {}; }
      await store.put(T_VOTES, 'settings', 'live', { Live: !!b.live, At: new Date().toISOString() });
    }
    return json({ live: await isLive() });
  }
});

// POST /api/manage/vote-repick (owner only) – pick this week's four again, e.g. after correcting a release.
// Only while nobody has voted, so nobody's vote is lost ({clearVotes:true} clears test votes, but only while the vote is hidden).
app.http('voteRepick', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/vote-repick',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Owner only.' }, 403);
    try {
      const now = weekOf();
      let b = {}; try { b = await request.json(); } catch { b = {}; }
      const rows = await store.rows(T_VOTES, now.week);
      const votes = rows.filter(r => r.rk.startsWith('count-')).reduce((a, r) => a + (Number(r.Votes) || 0), 0);
      // {clearVotes:true} also wipes this week's votes – only for clearing test votes before the vote is live
      if (votes && !(b.clearVotes && !(await isLive()))) return json({ error: "People have already voted this week, so it can't be picked again.", votes }, 409);
      for (const r of rows) if (/^(count|voter|ip)-/.test(r.rk)) await store.del(T_VOTES, now.week, r.rk);
      const old = rows.find(r => r.rk === 'poll');
      await store.del(T_VOTES, now.week, 'poll');
      const s = await cat.load();
      const avoid = new Set(old ? [old.Type + '|' + old.Year] : []);
      for (let i = 1; i <= 12; i++) { const o = await store.get(T_VOTES, addDays(now.week, -7 * i), 'poll'); if (o) avoid.add(o.Type + '|' + o.Year); }
      const fresh = pickFor(s, now.week + '|again' + (old ? '|' + old.Type + old.Year : ''), avoid);
      if (!fresh) return json({ error: 'Not enough releases to pick from.' }, 500);
      await store.put(T_VOTES, now.week, 'poll', fresh);
      return json({ ok: true, type: fresh.Type, year: fresh.Year });
    } catch (err) { context.error(err); return json({ error: 'Could not pick again.' }, 500); }
  }
});

module.exports = { weekOf, ukMoment, pickFor, weekNo };
