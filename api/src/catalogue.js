// Moving off SQL, step 2: read the public pages' data from the nightly storage copy instead of SQL.
//
// The overnight run copies every music.* table to the private "catalogue" container (step 1, functions/export.js).
// This file loads the latest good copy into memory and indexes it, so the public pages can be answered without
// waking the database. Which source the pages use is a switch kept in storage ("data-source": "sql" or "catalogue"),
// so it can be flipped (and flipped back) without a deploy. While the switch is on "sql" nothing here is used,
// except by the side-by-side check (GET /api/manage/compare), which answers each page both ways and compares them.
//
// Safety: if the copy can't be read, or is older than the last change made to the database, the pages use SQL.
const { BlobServiceClient } = require('@azure/storage-blob');
const zlib = require('zlib');
const store = require('./store');
const { isOwner, isRunner } = require('./auth');

const TABLES = ['Bands', 'Releases', 'Images', 'Gigs', 'GigBands', 'Venues', 'ReleaseLinks', 'Remembering', 'FavouriteYears', 'FavouriteAlbums'];

let containerP;
function container() {
  if (!containerP) containerP = Promise.resolve(BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('catalogue'));
  return containerP;
}
const readJson = async path => JSON.parse((await (await container()).getBlobClient(path).downloadToBuffer()).toString('utf8'));

// ---------- loading ----------
let snap = null, manifest = null, checkedAt = 0, loading = null;
async function load({ fresh = false } = {}) {
  if (snap && !fresh && Date.now() - checkedAt < 60000) return snap;
  if (loading) return loading;
  loading = (async () => {
    try {
      const m = await readJson('master/latest.json');
      checkedAt = Date.now();
      if (!m || !m.ok || !m.day) throw new Error('no good copy');
      if (snap && manifest && manifest.day === m.day && manifest.finishedAt === m.finishedAt) return snap;
      const t = {};
      await Promise.all(TABLES.map(async n => {
        const buf = await (await container()).getBlobClient(`master/${m.day}/${n}.json.gz`).downloadToBuffer();
        t[n] = JSON.parse(zlib.gunzipSync(buf).toString('utf8')).rows;
      }));
      snap = build(t);
      manifest = { day: m.day, finishedAt: m.finishedAt };
      snap.manifest = manifest;
      return snap;
    } finally { loading = null; }
  })();
  return loading;
}

const sortBy = (arr, ...keys) => arr.sort((a, b) => { for (const k of keys) { const d = k(a, b); if (d) return d; } return 0; });
function build(t) {
  const s = { ...t };
  s.bands = new Map(t.Bands.map(b => [b.BandId, b]));
  s.venues = new Map(t.Venues.map(v => [v.VenueId, v]));
  s.gigsById = new Map(t.Gigs.map(g => [g.GigId, g]));
  s.relById = new Map(t.Releases.map(r => [r.ReleaseId, r]));
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (k == null) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const imgOrder = (a, b) => a.SortOrder - b.SortOrder || a.ImageId - b.ImageId;
  s.imgRel = group(t.Images, i => i.ReleaseId); for (const l of s.imgRel.values()) l.sort(imgOrder);
  s.imgGig = group(t.Images, i => i.GigId); for (const l of s.imgGig.values()) l.sort(imgOrder);
  s.gigBands = group(t.GigBands, x => x.GigId); for (const l of s.gigBands.values()) l.sort((a, b) => a.BillOrder - b.BillOrder);
  s.relByMD = group(t.Releases, r => r.ReleaseMonth + '-' + r.ReleaseDay);
  s.relByBand = group(t.Releases, r => r.BandId);
  s.gigsByMD = group(t.Gigs, g => g.GigMonth + '-' + g.GigDay);
  s.links = new Map(t.ReleaseLinks.map(l => [l.ReleaseId, l]));
  return s;
}

// ---------- which source ----------
const forced = new WeakMap();            // requests made by the side-by-side check
function force(request, source) { forced.set(request, source); }
const isForced = request => forced.has(request);
let switchCache = { v: null, at: 0 };
async function switchSetting() {
  if (switchCache.v && Date.now() - switchCache.at < 60000) return switchCache.v;
  const v = (await store.getStale('data-source').catch(() => undefined)) === 'catalogue' ? 'catalogue' : 'sql';
  switchCache = { v, at: Date.now() };
  return v;
}
async function setSwitch(v) {
  await store.setCached('data-source', 's', v === 'catalogue' ? 'catalogue' : 'sql');
  switchCache = { v: v === 'catalogue' ? 'catalogue' : 'sql', at: Date.now() };
}
// The time of the last change made to the database (the save wrapper records it whenever a save reaches SQL)
let changeCache = { v: 0, at: 0 };
async function lastChange() {
  if (Date.now() - changeCache.at < 30000) return changeCache.v;
  const v = Number(await store.getStale('db-changed').catch(() => 0)) || 0;
  changeCache = { v, at: Date.now() };
  return v;
}
async function noteChange() {
  const now = Date.now();
  changeCache = { v: now, at: now };
  await store.setCached('db-changed', 's', now);
}
// The loaded copy, or null if this request should use SQL
async function use(request) {
  const f = forced.get(request);
  if (f === 'sql') return null;
  if (f !== 'catalogue' && (await switchSetting()) !== 'catalogue') return null;
  try {
    const s = await load({ fresh: isRunner(request) });
    // never answer from a copy that's older than the last change to the database
    if (Date.parse(s.manifest.finishedAt) < await lastChange()) return null;
    return s;
  } catch { return null; }
}

// ---------- matching SQL's behaviour ----------
// The database compares text without regard to case (but with accents), and ignores trailing spaces.
const coll = new Intl.Collator('en', { sensitivity: 'accent' });
// (and, like the database's "word sort", it skips apostrophes and hyphens when ordering: The Killers before The K's)
const wordSort = t => String(t).replace(/['’-]/g, '');
const cmp = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : (coll.compare(wordSort(a), wordSort(b)) || coll.compare(String(a), String(b))));
const eqText = (a, b) => a != null && b != null && coll.compare(String(a).replace(/ +$/, ''), String(b).replace(/ +$/, '')) === 0;
const ukDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const d10 = v => (v == null ? null : String(v).slice(0, 10));

module.exports = { load, use, force, isForced, switchSetting, setSwitch, noteChange, sortBy, coll, cmp, eqText, ukDay, d10, isOwner };
