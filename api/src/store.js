// Cheap, always-awake storage so normal visitors never wake the SQL database (which pauses after an hour idle
// and costs vCore seconds every time it wakes):
//  - Table Storage for counters and small records (visits, Guess the Cover tallies and leaderboards)
//  - a private blob container "cache" holding ready-made API answers (each day's page, this week, stats, ...)
const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');

const CS = () => process.env.STORAGE_CONNECTION_STRING;

// ---------- Table Storage ----------
const tables = new Map();
async function table(name) {
  if (!tables.has(name)) {
    tables.set(name, (async () => {
      const t = TableClient.fromConnectionString(CS(), name);
      await t.createTable().catch(e => { if (e.statusCode !== 409) throw e; });
      return t;
    })().catch(e => { tables.delete(name); throw e; }));
  }
  return tables.get(name);
}
// Table keys can't contain / \ # ? or control characters
const key = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16)).replace(/%/g, '~').slice(0, 900) || '~';
const unkey = s => decodeURIComponent(String(s).replace(/~/g, '%'));

// Add n to a numeric field (safe when several visitors arrive at once)
async function incr(tableName, pk, rk, fields, extra = {}) {
  const t = await table(tableName);
  const PK = key(pk), RK = key(rk);
  for (let attempt = 0; attempt < 8; attempt++) {
    let e = null;
    try { e = await t.getEntity(PK, RK); } catch (err) { if (err.statusCode !== 404) throw err; }
    if (!e) {
      const ent = { partitionKey: PK, rowKey: RK, ...extra };
      for (const [f, n] of Object.entries(fields)) ent[f] = n;
      try { await t.createEntity(ent); return ent; } catch (err) { if (err.statusCode === 409) continue; throw err; }
    }
    const upd = { partitionKey: PK, rowKey: RK };
    for (const [f, n] of Object.entries(fields)) upd[f] = (Number(e[f]) || 0) + n;
    try { await t.updateEntity(upd, 'Merge', { etag: e.etag }); return { ...e, ...upd }; }
    catch (err) { if (err.statusCode === 412) continue; throw err; }
  }
  throw new Error('Too much contention updating ' + tableName);
}
async function get(tableName, pk, rk) {
  const t = await table(tableName);
  try { return await t.getEntity(key(pk), key(rk)); } catch (err) { if (err.statusCode === 404) return null; throw err; }
}
async function put(tableName, pk, rk, fields) {
  const t = await table(tableName);
  await t.upsertEntity({ partitionKey: key(pk), rowKey: key(rk), ...fields }, 'Replace');
}
async function insertIfNew(tableName, pk, rk, fields) {
  const t = await table(tableName);
  try { await t.createEntity({ partitionKey: key(pk), rowKey: key(rk), ...fields }); return true; }
  catch (err) { if (err.statusCode === 409) return false; throw err; }
}
async function del(tableName, pk, rk) {
  const t = await table(tableName);
  await t.deleteEntity(key(pk), key(rk)).catch(err => { if (err.statusCode !== 404) throw err; });
}
// All rows of one partition, or of several partitions (e.g. a list of dates)
async function rows(tableName, pks) {
  const t = await table(tableName);
  const out = [];
  for (const pk of [].concat(pks)) {
    const it = t.listEntities({ queryOptions: { filter: `PartitionKey eq '${key(pk).replace(/'/g, "''")}'` } });
    for await (const e of it) out.push({ ...e, pk: unkey(e.partitionKey), rk: unkey(e.rowKey) });
  }
  return out;
}
// All rows whose partition (a "YYYY-MM-DD" date) is between from and to, in one query
async function rowsBetween(tableName, from, to) {
  const t = await table(tableName);
  const out = [];
  const it = t.listEntities({ queryOptions: { filter: `PartitionKey ge '${key(from)}' and PartitionKey le '${key(to)}'` } });
  for await (const e of it) out.push({ ...e, pk: unkey(e.partitionKey), rk: unkey(e.rowKey) });
  return out;
}

// ---------- Blob cache of ready-made answers ----------
let containerP;
function cacheContainer() {
  if (!containerP) {
    containerP = (async () => {
      const c = BlobServiceClient.fromConnectionString(CS()).getContainerClient('cache');
      await c.createIfNotExists();        // private: only the site's API reads it
      return c;
    })().catch(e => { containerP = undefined; throw e; });
  }
  return containerP;
}
const mem = new Map();                      // per-instance copy, so most requests don't even touch blob storage
let ver = { v: null, at: 0 };
// Versions: g = everything, l = list pages (week, stats, favourites, years, search, bands, gigs), d = individual days ("MM-DD").
// Saving a release only refreshes its own day and the list pages; anything we can't place refreshes everything.
async function versions() {
  if (ver.v && Date.now() - ver.at < 30000) return ver.v;
  let v = { g: '1', l: '1', d: {} };
  try {
    const raw = (await (await cacheContainer()).getBlockBlobClient('version.txt').downloadToBuffer()).toString().trim();
    v = raw.startsWith('{') ? JSON.parse(raw) : { g: raw, l: raw, d: {} };
  } catch (err) { if (err.statusCode !== 404) throw err; }
  ver = { v, at: Date.now() };
  return v;
}
async function dataVersion() { return (await versions()).g; }
async function bumpVersion({ days = null } = {}) {
  const now = String(Date.now());
  const v = JSON.parse(JSON.stringify(await versions().catch(() => ({ g: '1', l: '1', d: {} }))));
  if (days && days.length) { v.l = now; for (const d of days) v.d[d] = now; }
  else { v.g = now; v.l = now; v.d = {}; }
  const s = JSON.stringify(v);
  await (await cacheContainer()).getBlockBlobClient('version.txt').upload(s, s.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  ver = { v, at: Date.now() };
  return now;
}
const blobName = k => 'api/' + k.replace(/[^A-Za-z0-9._=&-]/g, '_') + '.json';
async function getCached(k, stamp) {
  const m = mem.get(k);
  if (m && m.stamp === stamp) return m.body;
  try {
    const buf = await (await cacheContainer()).getBlockBlobClient(blobName(k)).downloadToBuffer();
    const e = JSON.parse(buf.toString());
    if (e.stamp === stamp) { mem.set(k, e); return e.body; }
  } catch (err) { if (err.statusCode !== 404 && !(err instanceof SyntaxError)) throw err; }
  return undefined;
}
// The last answer saved under this key, however old (used when the database can't be reached)
async function getStale(k) {
  const m = mem.get(k);
  if (m) return m.body;
  try {
    const e = JSON.parse((await (await cacheContainer()).getBlockBlobClient(blobName(k)).downloadToBuffer()).toString());
    return e.body;
  } catch { return undefined; }
}
async function setCached(k, stamp, body) {
  const e = { stamp, body, builtAt: new Date().toISOString() };
  mem.set(k, e);
  if (mem.size > 800) mem.delete(mem.keys().next().value);
  const s = JSON.stringify(e);
  await (await cacheContainer()).getBlockBlobClient(blobName(k)).upload(s, Buffer.byteLength(s), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

module.exports = { versions, incr, get, put, insertIfNew, del, rows, rowsBetween, key, unkey, dataVersion, bumpVersion, getCached, getStale, setCached };
