// Moving off SQL, step 1: copy the whole database into Azure Storage every night and prove the copy matches.
//
// Nothing reads these files yet - the site still runs from SQL. This only builds (and checks) the copy that
// later steps will switch the site over to.
//
// Private blob container "catalogue":
//   master/YYYY-MM-DD/<Table>.json.gz   every row of one music.* table (gzipped JSON: { table, columns, rows })
//   master/YYYY-MM-DD/manifest.json     row counts, fingerprints and the check result for every table
//   master/latest.json                  the most recent manifest (so later steps know which day to read)
// Dated copies older than KEEP_DAYS are removed.
//
// The overnight run (.github/scripts/nightly.py) calls, after applying the day's queued changes:
//   GET  /api/nightly/export                 -> { day, tables: [...] }  the tables to copy
//   POST /api/nightly/export {table}         -> copies one table, reads it back and checks it
//   POST /api/nightly/export {finish, results} -> writes the manifest, tidies old copies
// One table per request keeps each request short (the site's functions have a time limit per request).
const { app } = require('@azure/functions');
const { query, json, fail, ukDay } = require('../db');
const { isRunner } = require('../auth');
const { BlobServiceClient } = require('@azure/storage-blob');
const zlib = require('zlib');
const crypto = require('crypto');

const KEEP_DAYS = 14;
const SCHEMA = 'music';

let containerPromise;
function catalogue() {
  if (!containerPromise) {
    containerPromise = (async () => {
      const c = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('catalogue');
      await c.createIfNotExists();   // private: no public access
      return c;
    })().catch(err => { containerPromise = undefined; throw err; });
  }
  return containerPromise;
}

// A table's fingerprint: SHA-256 of its rows as JSON, in primary-key order.
// JSON is what's stored, so the fingerprint of what SQL returned and of what was read back must be identical.
const fingerprint = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

async function listTables() {
  const rows = await query(`SELECT TABLE_NAME AS T FROM INFORMATION_SCHEMA.TABLES
                             WHERE TABLE_SCHEMA = @s AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
                           { s: [require('mssql').NVarChar(128), SCHEMA] });
  return rows.map(r => r.T);
}

// Primary-key columns (in key order) so every export lists the rows in the same order; else all columns.
async function orderColumns(table) {
  const sql = require('mssql');
  const pk = await query(`SELECT k.COLUMN_NAME AS C FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
     WHERE t.TABLE_SCHEMA = @s AND t.TABLE_NAME = @t AND t.CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY k.ORDINAL_POSITION`,
    { s: [sql.NVarChar(128), SCHEMA], t: [sql.NVarChar(128), table] });
  const cols = await query(`SELECT COLUMN_NAME AS C, DATA_TYPE AS D FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`,
    { s: [sql.NVarChar(128), SCHEMA], t: [sql.NVarChar(128), table] });
  const sortable = cols.filter(c => !['text', 'ntext', 'image', 'xml', 'geography', 'geometry'].includes(c.D)).map(c => c.C);
  return { order: pk.length ? pk.map(p => p.C) : sortable, columns: cols.map(c => ({ name: c.C, type: c.D })) };
}

const q = name => '[' + String(name).replace(/]/g, ']]') + ']';

async function exportTable(day, table) {
  const tables = await listTables();
  if (!tables.includes(table)) return { table, ok: false, error: 'No such table' };
  const { order, columns } = await orderColumns(table);
  const rows = await query(`SELECT * FROM ${SCHEMA}.${q(table)}${order.length ? ' ORDER BY ' + order.map(q).join(', ') : ''}`);
  const fp = fingerprint(rows);
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ table, exportedAt: new Date().toISOString(), columns, rows })));
  const c = await catalogue();
  const path = `master/${day}/${table}.json.gz`;
  await c.getBlockBlobClient(path).uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/gzip' } });

  // Check: read the file back and compare it with SQL (row count now, and the fingerprint of every row)
  const back = JSON.parse(zlib.gunzipSync(await c.getBlobClient(path).downloadToBuffer()).toString('utf8'));
  const now = await query(`SELECT COUNT_BIG(*) AS N FROM ${SCHEMA}.${q(table)}`);
  const countNow = Number(now[0].N);
  const fpBack = fingerprint(back.rows);
  const problems = [];
  if (back.rows.length !== rows.length) problems.push(`file has ${back.rows.length} rows, export had ${rows.length}`);
  if (countNow !== rows.length) problems.push(`SQL now has ${countNow} rows, export had ${rows.length}`);
  if (fpBack !== fp) problems.push('rows in the file differ from SQL');
  return { table, path, rows: rows.length, bytes: body.length, fingerprint: fp, ok: problems.length === 0, problems };
}

async function finish(day, results) {
  const c = await catalogue();
  const tables = await listTables();
  const got = new Map((results || []).map(r => [r.table, r]));
  const missing = tables.filter(t => !got.has(t));
  const bad = [...got.values()].filter(r => !r.ok).map(r => r.table);
  const manifest = {
    day, finishedAt: new Date().toISOString(), schema: SCHEMA,
    ok: missing.length === 0 && bad.length === 0, missing, failed: bad,
    totalRows: [...got.values()].reduce((n, r) => n + (r.rows || 0), 0),
    tables: tables.map(t => got.get(t) || { table: t, ok: false, problems: ['not exported'] })
  };
  const text = Buffer.from(JSON.stringify(manifest, null, 1));
  const opts = { blobHTTPHeaders: { blobContentType: 'application/json' } };
  await c.getBlockBlobClient(`master/${day}/manifest.json`).uploadData(text, opts);
  if (manifest.ok) await c.getBlockBlobClient('master/latest.json').uploadData(text, opts);   // only point at a good copy

  // Tidy: remove dated copies older than KEEP_DAYS
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  let removed = 0;
  for await (const b of c.listBlobsFlat({ prefix: 'master/' })) {
    const m = b.name.match(/^master\/(\d{4}-\d{2}-\d{2})\//);
    if (m && m[1] < cutoff) { await c.getBlobClient(b.name).deleteIfExists(); removed++; }
  }
  return { ...manifest, tables: undefined, tableCount: tables.length, removedOldFiles: removed };
}

app.http('nightlyExport', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'nightly/export',
  handler: async (request, context) => {
    if (!isRunner(request)) return json({ error: 'Only the overnight run.' }, 403);
    const day = ukDay();
    try {
      if (request.method === 'GET') {
        // The run is scheduled several times a night: once today's copy is good, later runs stop here
        // (this check only reads storage, so it doesn't wake the database)
        if (request.query.get('force') !== '1') {
          const m = (await catalogue()).getBlobClient(`master/${day}/manifest.json`);
          if (await m.exists() && JSON.parse((await m.downloadToBuffer()).toString('utf8')).ok) return json({ day, done: true, tables: [] });
        }
        return json({ day, tables: await listTables() });
      }
      const b = await request.json().catch(() => ({}));
      if (b.finish) return json(await finish(day, b.results));
      if (!b.table) return json({ error: 'Give {table} or {finish: true, results}.' }, 400);
      return json(await exportTable(day, String(b.table)));
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/manage/export-status (owner) -> the last good copy's manifest (read from storage; doesn't wake SQL)
app.http('manageExportStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/export-status',
  handler: async (request, context) => {
    if (!require('../auth').isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const c = await catalogue();
      const blob = c.getBlobClient('master/latest.json');
      if (!(await blob.exists())) return json({ ok: false, note: 'No copy yet - the first one is made in the overnight run.' });
      return json(JSON.parse((await blob.downloadToBuffer()).toString('utf8')));
    } catch (err) { return fail(context, err); }
  }
});
