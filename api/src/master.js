// Moving off SQL, step 3: the storage copy becomes the master. Saves change it directly.
//
// Layout (private container "catalogue"):
//   master/latest.json                 the manifest: which file holds each table now (+ finishedAt = time of the last change)
//   master/YYYY-MM-DD/<Table>.json.gz  a full daily copy (made by the overnight run; 14 days kept)
//   master/live/<stamp>/<Table>.json.gz tables changed by a save since then
// Each save reads the tables it needs, changes them, writes the changed ones as new files and then points
// latest.json at them - only if latest.json hasn't changed meanwhile (otherwise it starts again), so two saves at
// once can't lose each other's changes.
//
// Which store the admin saves go to is the switch "write-target" ("sql" | "storage"), kept in the cache container.
// Every save made while it's on "storage" is also written to a journal (cache container, journal/), so if we ever
// need to go back to SQL the same saves can be replayed into it by the overnight run (POST /api/manage/write-target).
const { BlobServiceClient } = require('@azure/storage-blob');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./store');

let containerP;
function container() {
  if (!containerP) containerP = Promise.resolve(BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('catalogue'));
  return containerP;
}
const fingerprint = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

// ---------- the switch ----------
let wt = { v: null, at: 0 };
async function target() {
  if (wt.v && Date.now() - wt.at < 30000) return wt.v;
  const v = (await store.getStale('write-target').catch(() => undefined)) === 'storage' ? 'storage' : 'sql';
  wt = { v, at: Date.now() };
  return v;
}
const on = async () => (await target()) === 'storage';
async function setTarget(v) {
  v = v === 'storage' ? 'storage' : 'sql';
  await store.setCached('write-target', 's', v);
  wt = { v, at: Date.now() };
}

// ---------- reading ----------
async function manifest() {
  const blob = (await container()).getBlobClient('master/latest.json');
  const props = await blob.getProperties();
  const m = JSON.parse((await blob.downloadToBuffer()).toString('utf8'));
  return { m, etag: props.etag };
}
const pathOf = (m, name) => ((m.tables || []).find(t => t.table === name) || {}).path || `master/${m.day}/${name}.json.gz`;
async function readTable(m, name) {
  const buf = await (await container()).getBlobClient(pathOf(m, name)).downloadToBuffer();
  const f = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  return { rows: f.rows || [], columns: f.columns || null };
}
async function read(names) {
  const { m } = await manifest();
  const out = {};
  await Promise.all(names.map(async n => { out[n] = (await readTable(m, n)).rows; }));
  return out;
}

// ---------- changing ----------
// change(['Releases', 'Images'], async t => { ...change t.Releases / t.Images in place...; return result })
// t._columns[name] holds each table's column list (for new rows). Return { result, unchanged: [...] } to skip writing a table.
async function change(names, fn, why = '') {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { m, etag } = await manifest();
    if (!m.ok) throw new Error('The storage copy is not in a good state - not saving.');
    const t = { _columns: {} };
    await Promise.all(names.map(async n => { const x = await readTable(m, n); t[n] = x.rows; t._columns[n] = x.columns; }));
    const before = Object.fromEntries(names.map(n => [n, fingerprint(t[n])]));
    const result = await fn(t);
    const changed = names.filter(n => fingerprint(t[n]) !== before[n]);
    if (!changed.length) return result;
    const stamp = new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
    const c = await container();
    const entries = new Map((m.tables || []).map(x => [x.table, { ...x }]));
    for (const n of changed) {
      const path = `master/live/${stamp}/${n}.json.gz`;
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ table: n, savedAt: new Date().toISOString(), columns: t._columns[n], rows: t[n] })));
      await c.getBlockBlobClient(path).uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/gzip' } });
      entries.set(n, { table: n, path, rows: t[n].length, bytes: body.length, fingerprint: fingerprint(t[n]), ok: true, problems: [] });
    }
    const nm = { ...m, finishedAt: new Date().toISOString(), source: 'storage', lastSave: String(why).slice(0, 100),
                 tables: [...entries.values()], totalRows: [...entries.values()].reduce((s, x) => s + (x.rows || 0), 0) };
    const text = Buffer.from(JSON.stringify(nm, null, 1));
    try {
      await c.getBlockBlobClient('master/latest.json').uploadData(text, { blobHTTPHeaders: { blobContentType: 'application/json' }, conditions: { ifMatch: etag } });
    } catch (err) {
      if (err.statusCode === 412) { await new Promise(r => setTimeout(r, 150 + Math.random() * 400)); continue; }   // someone else saved first: redo
      throw err;
    }
    require('./catalogue').forget();
    return result;
  }
  throw new Error('The site was busy saving - please try again.');
}

// ---------- helpers for rows ----------
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');     // DATETIME2(0): whole seconds
const dateIso = d => `${d}T00:00:00.000Z`;                                       // DATE
const nextId = (rows, k) => rows.reduce((mx, r) => Math.max(mx, Number(r[k]) || 0), 0) + 1;
// A new row with every column the table has (NULL unless given)
function newRow(t, table, values) {
  const cols = (t._columns && t._columns[table] || []).map(c => c.name);
  const keys = cols.length ? cols : Object.keys((t[table] || [])[0] || values);
  const o = {};
  for (const k of keys) o[k] = null;
  return Object.assign(o, values);
}
// Release / gig date columns the database used to work out itself
function setReleaseDate(r, d) { r.ReleaseDate = dateIso(d); r.ReleaseYear = +d.slice(0, 4); r.ReleaseMonth = +d.slice(5, 7); r.ReleaseDay = +d.slice(8, 10); }
function setGigDate(g, d) { g.GigDate = dateIso(d); g.GigMonth = +d.slice(5, 7); g.GigDay = +d.slice(8, 10); }
// The database compared names without regard to case and ignored trailing spaces
const coll = new Intl.Collator('en', { sensitivity: 'accent' });
const same = (a, b) => a != null && b != null && coll.compare(String(a).replace(/ +$/, ''), String(b).replace(/ +$/, '')) === 0;
const d10 = v => (v == null ? null : String(v).slice(0, 10));

// ---------- journal (for going back to SQL) ----------
async function journalAdd(item) {
  const name = `journal/${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}.json`;
  const s = JSON.stringify({ ...item, savedAt: new Date().toISOString() });
  const c = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('cache');
  await c.getBlockBlobClient(name).upload(s, Buffer.byteLength(s), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}
async function journalToQueue() {
  const c = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('cache');
  const names = [];
  for await (const b of c.listBlobsFlat({ prefix: 'journal/' })) names.push(b.name);
  names.sort();
  let moved = 0;
  for (const n of names) {
    const item = JSON.parse((await c.getBlockBlobClient(n).downloadToBuffer()).toString());
    const q = 'queue/' + n.slice('journal/'.length);
    const s = JSON.stringify(item);
    await c.getBlockBlobClient(q).upload(s, Buffer.byteLength(s), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    await c.getBlockBlobClient(n).deleteIfExists();
    moved++;
  }
  return moved;
}
async function journalCount() {
  const c = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('cache');
  let n = 0; for await (const b of c.listBlobsFlat({ prefix: 'journal/' })) { n++; void b; }
  return n;
}

// ---------- the overnight daily copy (replaces the SQL export once storage is the master) ----------
async function daily(day, keepDays = 14) {
  const { m, etag } = await manifest();
  const c = await container();
  if (m.day === day && !(m.tables || []).some(x => !String(x.path || '').startsWith(`master/${day}/`))) return { day, done: true };
  const tables = [];
  for (const x of m.tables || []) {
    const { rows, columns } = await readTable(m, x.table);
    const path = `master/${day}/${x.table}.json.gz`;
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ table: x.table, exportedAt: new Date().toISOString(), columns, rows })));
    await c.getBlockBlobClient(path).uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/gzip' } });
    const back = JSON.parse(zlib.gunzipSync(await c.getBlobClient(path).downloadToBuffer()).toString('utf8'));
    const ok = back.rows.length === rows.length && fingerprint(back.rows) === fingerprint(rows);
    tables.push({ table: x.table, path, rows: rows.length, bytes: body.length, fingerprint: fingerprint(rows), ok, problems: ok ? [] : ['read-back mismatch'] });
  }
  const bad = tables.filter(x => !x.ok).map(x => x.table);
  const nm = { ...m, day, ok: bad.length === 0, failed: bad, missing: [], tables, totalRows: tables.reduce((s, x) => s + x.rows, 0), dailyAt: new Date().toISOString() };
  const text = Buffer.from(JSON.stringify(nm, null, 1));
  await c.getBlockBlobClient(`master/${day}/manifest.json`).uploadData(text, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  let pointed = false;
  if (nm.ok) {
    try { await c.getBlockBlobClient('master/latest.json').uploadData(text, { blobHTTPHeaders: { blobContentType: 'application/json' }, conditions: { ifMatch: etag } }); pointed = true; }
    catch (err) { if (err.statusCode !== 412) throw err; }   // a save happened meanwhile: keep it; tomorrow's copy will include it
    require('./catalogue').forget();
  }
  // tidy: dated copies older than keepDays, and live files from before today's copy that nothing points at
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  const inUse = new Set(((await manifest()).m.tables || []).map(x => x.path));
  const liveCut = new Date(Date.now() - 2 * 86400000).toISOString().replace(/[-:.]/g, '').slice(0, 8);
  let removed = 0;
  for await (const b of c.listBlobsFlat({ prefix: 'master/' })) {
    const dm = b.name.match(/^master\/(\d{4}-\d{2}-\d{2})\//), lm = b.name.match(/^master\/live\/(\d{8})/);
    if ((dm && dm[1] < cutoff) || (lm && lm[1] < liveCut && !inUse.has(b.name))) { await c.getBlobClient(b.name).deleteIfExists(); removed++; }
  }
  return { day, ok: nm.ok, pointed, failed: bad, totalRows: nm.totalRows, removedOldFiles: removed };
}

module.exports = { target, on, setTarget, read, change, newRow, nextId, nowIso, dateIso, setReleaseDate, setGigDate, same, d10, coll,
                   journalAdd, journalToQueue, journalCount, daily, manifest };
