const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { sql, query, json } = require('../db');

const { isOwner } = require('../auth');

function mediaBaseUrl() {
  const cs = process.env.STORAGE_CONNECTION_STRING || '';
  const account = (cs.match(/AccountName=([^;]+)/) || [])[1];
  return account ? `https://${account}.blob.core.windows.net/media/` : null;
}

async function readImportFile(name) {
  const svc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
  const container = svc.getContainerClient('import');
  if (!(await container.exists())) throw new Error("There's no container called 'import' in the storage account.");
  // Accept the file at the top level or inside a folder (e.g. _import/releases-11.json)
  const seen = [];
  for await (const b of container.listBlobsFlat()) {
    seen.push(b.name);
    if (b.name === name || b.name.endsWith('/' + name)) {
      const buf = await container.getBlobClient(b.name).downloadToBuffer();
      return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
    }
  }
  throw new Error(`${name} isn't in the 'import' container. Files found: ${seen.slice(0, 20).join(', ') || 'none'}`);
}

// One set-based batch: bands -> releases -> images. Safe to run more than once.
const IMPORT_SQL = `
SET NOCOUNT ON;
DECLARE @rows TABLE (
  RowNo INT, Band NVARCHAR(200), ArtistDisplay NVARCHAR(300), Title NVARCHAR(400),
  ReleaseType NVARCHAR(20), ReleaseDate DATE, ChartPosition INT, ChartNote NVARCHAR(200),
  Label NVARCHAR(200), WriteUp NVARCHAR(MAX), TagNotes NVARCHAR(500), Status NVARCHAR(20),
  OnSonos BIT, Images NVARCHAR(MAX), Region NVARCHAR(10));

INSERT INTO @rows
SELECT j.[key] + 0, v.Band, v.ArtistDisplay, v.Title, v.ReleaseType, v.ReleaseDate, v.ChartPosition,
       v.ChartNote, v.Label, v.WriteUp, v.TagNotes, v.Status, v.OnSonos, v.Images, v.Region
FROM OPENJSON(@payload) j
CROSS APPLY OPENJSON(j.value) WITH (
  Band NVARCHAR(200) '$.band', ArtistDisplay NVARCHAR(300) '$.artistDisplay', Title NVARCHAR(400) '$.title',
  ReleaseType NVARCHAR(20) '$.type', ReleaseDate DATE '$.date', ChartPosition INT '$.chart',
  ChartNote NVARCHAR(200) '$.chartNote', Label NVARCHAR(200) '$.label', WriteUp NVARCHAR(MAX) '$.writeUp',
  TagNotes NVARCHAR(500) '$.tagNotes', Status NVARCHAR(20) '$.status', OnSonos BIT '$.onSonos',
  Images NVARCHAR(MAX) '$.images' AS JSON, Region NVARCHAR(10) '$.region') v;

INSERT INTO music.Bands (Name)
SELECT DISTINCT r.Band FROM @rows r
WHERE NOT EXISTS (SELECT 1 FROM music.Bands b WHERE b.Name = r.Band);

DECLARE @map TABLE (RowNo INT, ReleaseId INT);

MERGE music.Releases AS t
USING (SELECT r.*, b.BandId FROM @rows r JOIN music.Bands b ON b.Name = r.Band) AS s
ON t.BandId = s.BandId AND t.Title = s.Title AND t.ReleaseDate = s.ReleaseDate
WHEN MATCHED THEN UPDATE SET
  ArtistDisplay = s.ArtistDisplay, ReleaseType = s.ReleaseType, ChartPosition = s.ChartPosition,
  ChartNote = s.ChartNote, Label = COALESCE(s.Label, t.Label), WriteUp = COALESCE(s.WriteUp, t.WriteUp),
  TagNotes = s.TagNotes, Status = s.Status, OnSonosPlaylist = s.OnSonos, ReleaseRegion = s.Region, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (BandId, ArtistDisplay, Title, ReleaseType, ReleaseDate, ChartPosition, ChartNote, Label, WriteUp, TagNotes, Status, OnSonosPlaylist, ReleaseRegion)
  VALUES (s.BandId, s.ArtistDisplay, s.Title, s.ReleaseType, s.ReleaseDate, s.ChartPosition, s.ChartNote,
          s.Label, s.WriteUp, s.TagNotes, s.Status, s.OnSonos, s.Region)
OUTPUT s.RowNo, inserted.ReleaseId INTO @map;

-- (the web login has no DELETE permission, so images are upserted rather than replaced)
MERGE music.Images AS t
USING (
  SELECT m.ReleaseId, img.Kind, img.Path, @base + img.UrlPath AS PublicUrl,
         CONCAT(img.Kind, ' cover of ', r.Title, ' by ', COALESCE(r.ArtistDisplay, r.Band)) AS AltText, img.SortOrder
  FROM @rows r JOIN @map m ON m.RowNo = r.RowNo
  CROSS APPLY OPENJSON(r.Images) WITH (Kind NVARCHAR(20) '$.kind', Path NVARCHAR(400) '$.path',
    UrlPath NVARCHAR(600) '$.urlPath', SortOrder INT '$.order') img
) AS s
ON t.ReleaseId = s.ReleaseId AND t.BlobPath = s.Path
WHEN MATCHED THEN UPDATE SET Kind = s.Kind, PublicUrl = s.PublicUrl, AltText = s.AltText, SortOrder = s.SortOrder
WHEN NOT MATCHED THEN INSERT (ReleaseId, Kind, BlobPath, PublicUrl, AltText, SortOrder)
  VALUES (s.ReleaseId, s.Kind, s.Path, s.PublicUrl, s.AltText, s.SortOrder);

SELECT (SELECT COUNT(*) FROM @rows) AS RowsInFile,
       (SELECT COUNT(*) FROM @map) AS ReleasesSaved,
       (SELECT COUNT(*) FROM music.Images i JOIN @map m ON m.ReleaseId = i.ReleaseId) AS ImagesLinked,
       (SELECT COUNT(*) FROM music.Bands) AS BandsTotal,
       (SELECT COUNT(*) FROM music.Releases) AS ReleasesTotal;`;

// POST or GET /api/manage/import ("admin" is reserved by Azure Functions)?file=releases-11.json
app.http('adminImport', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/import',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const file = request.query.get('file') || '';
    if (!/^[\w.-]+\.json$/.test(file)) return json({ error: 'Give ?file=releases-MM.json' }, 400);
    const base = mediaBaseUrl();
    if (!base) return json({ error: 'STORAGE_CONNECTION_STRING is not set.' }, 500);
    try {
      // ?url= lets a month file be supplied from this site's own GitHub repository instead of the import container
      const src = request.query.get('url');
      let rows;
      if (src) {
        if (!src.startsWith('https://raw.githubusercontent.com/gigsintoon/gigsintoon-site/')) return json({ ok: false, error: 'url not allowed' }, 400);
        const r = await fetch(src);
        if (!r.ok) return json({ ok: false, error: 'Could not fetch ' + src + ' (' + r.status + ')' }, 400);
        rows = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
      } else rows = await readImportFile(file);
      return json({ ok: true, file, ...(await runImport(rows, base)) });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

async function runImport(rows, base) {
  const result = await query(IMPORT_SQL, {
    payload: [sql.NVarChar(sql.MAX), JSON.stringify(rows)],
    base: [sql.NVarChar(400), base]
  });
  // Colours changed on the admin page win over the spreadsheet until they've been copied back into it
  result[0].StatusOverridesKept = await applyStatusOverrides();
  return result[0];
}

function failDetail(context, err) {
  context.error(err);
  const details = [err.name, err.code, err.statusCode, err.message,
    ...(err.precedingErrors || []).map(e => e.message),
    err.originalError && err.originalError.message].filter(Boolean);
  return json({ ok: false, error: details.join(' | ') || String(err) }, 500);
}

function mediaContainer() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('media');
}

// Blob paths look like the folder on the laptop: "11 - November/11th/Band - Title.jpg"
function cleanPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.includes('..') || s.length > 400) return null;
  return s;
}

const CONTENT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif' };

// POST /api/manage/release  body: one release (same shape as a row in releases-MM.json) or an array of them.
// Adds the release, or updates it if band + title + date already exist; links any images listed.
app.http('adminRelease', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/release',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const body = await request.json();
      const rows = Array.isArray(body) ? body : [body];
      for (const r of rows) {
        if (!r.band || !r.title || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) {
          return json({ ok: false, error: 'Each release needs band, title and date (YYYY-MM-DD).' }, 400);
        }
        r.type = r.type || 'Album'; r.status = r.status || 'NotPosted'; r.onSonos = !!r.onSonos;
        r.images = (r.images || []).map((img, i) => {
          const path = cleanPath(img.path);
          return { kind: img.kind || 'Cover', path, urlPath: path.split('/').map(encodeURIComponent).join('/'), order: img.order || i + 1 };
        });
      }
      const result = await runImport(rows, mediaBaseUrl());
      const saved = await query(
        `SELECT r.ReleaseId, b.Name AS Band, r.Title, r.ReleaseDate, r.Status,
                (SELECT i.Kind, i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId
                  ORDER BY i.SortOrder FOR JSON PATH) AS Images
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE EXISTS (SELECT 1 FROM OPENJSON(@p) WITH (band NVARCHAR(200), title NVARCHAR(400), date DATE) j
                         WHERE j.band = b.Name AND j.title = r.Title AND j.date = r.ReleaseDate)`,
        { p: [sql.NVarChar(sql.MAX), JSON.stringify(rows)] });
      saved.forEach(x => { x.Images = x.Images ? JSON.parse(x.Images) : []; });
      return json({ ok: true, ...result, saved });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/upload?path=11 - November/11th/Band - Title.jpg   body: the image bytes
// or  POST /api/manage/upload?path=...&url=https://...   (the site downloads the image itself)
// Saves the image into the media container and returns its permanent public URL.
app.http('adminUpload', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/upload',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const path = cleanPath(request.query.get('path'));
    const ext = (path || '').split('.').pop().toLowerCase();
    if (!path || !CONTENT_TYPES[ext]) return json({ ok: false, error: 'Give ?path= ending in .jpg, .jpeg, .png, .webp, .gif or .jfif' }, 400);
    try {
      let buf;
      const from = request.query.get('url');
      if (from) {
        // Fetch the image server-side (e.g. Apple Music / Wikipedia / Discogs cover URL)
        if (!/^https:\/\//i.test(from)) return json({ ok: false, error: 'url must be https' }, 400);
        const r = await fetch(from, { headers: { 'User-Agent': 'gigsintoon-site/1.0 (cover import)' } });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !type.startsWith('image/')) return json({ ok: false, error: `Couldn't fetch an image (${r.status} ${type})` }, 400);
        buf = Buffer.from(await r.arrayBuffer());
      } else {
        buf = Buffer.from(await request.arrayBuffer());
      }
      if (!buf.length) return json({ ok: false, error: 'The upload was empty.' }, 400);
      await mediaContainer().getBlockBlobClient(path).uploadData(buf, { blobHTTPHeaders: { blobContentType: CONTENT_TYPES[ext] } });
      return json({ ok: true, path, bytes: buf.length, url: mediaBaseUrl() + path.split('/').map(encodeURIComponent).join('/') });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/media-delete  body: { "paths": [...], "confirm": true }
// Deletes exactly the listed images from the media container. Without "confirm": true it only reports what it would do.
app.http('adminMediaDelete', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/media-delete',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const body = await request.json();
      let paths = (body.paths || []).map(cleanPath).filter(Boolean);
      // { "allTextFiles": true } -> every .txt in the container (never images)
      if (body.allTextFiles === true) {
        paths = [];
        for await (const b of mediaContainer().listBlobsFlat()) if (/\.txt$/i.test(b.name)) paths.push(b.name);
      }
      const inUse = new Set((await query(`SELECT BlobPath FROM music.Images`)).map(r => r.BlobPath));
      const c = mediaContainer();
      const result = { deleted: [], wouldDelete: [], notFound: [], keptInUse: [] };
      const listed = body.allTextFiles === true;   // names came straight from storage, so they exist
      const todo = [];
      for (const p of paths) {
        if (listed && !/\.txt$/i.test(p)) continue;
        if (inUse.has(p)) { result.keptInUse.push(p); continue; }
        todo.push(p);
      }
      // 20 at a time so a few thousand files finish inside the 45-second web limit
      for (let k = 0; k < todo.length; k += 20) {
        await Promise.all(todo.slice(k, k + 20).map(async p => {
          const blob = c.getBlobClient(p);
          if (body.confirm === true) {
            const r = await blob.deleteIfExists();
            (r.succeeded ? result.deleted : result.notFound).push(p);
          } else if (listed || await blob.exists()) result.wouldDelete.push(p);
          else result.notFound.push(p);
        }));
      }
      return json({ ok: true, confirm: body.confirm === true, counts: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])), ...result });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/reset-releases  body: { "confirm": "DELETE ALL RELEASES" }
// Clears releases, their images (database rows only - files in storage are kept) and bands not on a gig bill.
app.http('adminResetReleases', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/reset-releases',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const body = await request.json().catch(() => ({}));
      if (body.confirm !== 'DELETE ALL RELEASES') return json({ ok: false, error: 'Send { "confirm": "DELETE ALL RELEASES" }' }, 400);
      const r = await query(`SET NOCOUNT ON;
        DELETE FROM music.Images WHERE ReleaseId IS NOT NULL;
        DELETE FROM music.SocialPosts WHERE ReleaseId IS NOT NULL;
        DELETE FROM music.Releases;
        DELETE FROM music.Bands WHERE BandId NOT IN (SELECT BandId FROM music.GigBands);
        SELECT (SELECT COUNT(*) FROM music.Bands) AS Bands, (SELECT COUNT(*) FROM music.Releases) AS Releases,
               (SELECT COUNT(*) FROM music.Images) AS Images;`);
      return json({ ok: true, ...r[0] });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// GET /api/manage/media?path=...  -> the image itself (same-origin, so the browser can read it)
app.http('adminMediaGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/media',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const path = cleanPath(request.query.get('path'));
    if (!path) return json({ error: 'Give ?path=' }, 400);
    try {
      const blob = mediaContainer().getBlobClient(path);
      if (!(await blob.exists())) return json({ error: 'Not found' }, 404);
      const props = await blob.getProperties();
      return { status: 200, body: await blob.downloadToBuffer(), headers: { 'Content-Type': props.contentType || 'application/octet-stream', 'Cache-Control': 'no-store' } };
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/media-copy  body: { "from": "...", "to": "..." }  -> copies a file inside the media container
app.http('adminMediaCopy', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/media-copy',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const body = await request.json();
      const from = cleanPath(body.from), to = cleanPath(body.to);
      if (!from || !to) return json({ ok: false, error: 'Give from and to' }, 400);
      const c = mediaContainer();
      const src = c.getBlobClient(from);
      if (!(await src.exists())) return json({ ok: false, error: 'Source not found' }, 404);
      const props = await src.getProperties();
      await c.getBlockBlobClient(to).uploadData(await src.downloadToBuffer(), { blobHTTPHeaders: { blobContentType: props.contentType } });
      return json({ ok: true, from, to, url: mediaBaseUrl() + to.split('/').map(encodeURIComponent).join('/') });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/release-delete  body: { "band": "...", "title": "...", "date": "YYYY-MM-DD", "confirm": true }
// Removes one release (and its image links - the image files stay in storage).
app.http('adminReleaseDelete', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/release-delete',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      if (!b.band || !b.title || !b.date) return json({ ok: false, error: 'Give band, title and date' }, 400);
      const found = await query(
        `SELECT r.ReleaseId, b.Name, r.Title, r.ReleaseDate FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE b.Name = @band AND r.Title = @title AND r.ReleaseDate = @date`,
        { band: [sql.NVarChar(200), b.band], title: [sql.NVarChar(400), b.title], date: [sql.Date, b.date] });
      if (found.length !== 1 || b.confirm !== true) return json({ ok: true, confirm: false, found });
      await query(`DELETE FROM music.Images WHERE ReleaseId = @id; DELETE FROM music.SocialPosts WHERE ReleaseId = @id;
                   DELETE FROM music.Releases WHERE ReleaseId = @id;`, { id: [sql.Int, found[0].ReleaseId] });
      return json({ ok: true, confirm: true, deleted: found[0] });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/release-images  body: [{ band, title, date, images: [{ kind, path, order }] }]
// Links images to releases that already exist, without touching any other release details.
app.http('adminReleaseImages', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/release-images',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const body = await request.json();
      const rows = [];
      for (const r of (Array.isArray(body) ? body : [body])) {
        (r.images || []).forEach((img, i) => {
          const path = cleanPath(img.path);
          if (path) rows.push({ band: r.band, title: r.title, date: r.date, kind: img.kind || 'Cover', path,
            url: mediaBaseUrl() + path.split('/').map(encodeURIComponent).join('/'), order: img.order || i + 1 });
        });
      }
      const res = await query(`SET NOCOUNT ON;
        DECLARE @x TABLE (ReleaseId INT, Kind NVARCHAR(20), Path NVARCHAR(400), Url NVARCHAR(600), SortOrder INT, Alt NVARCHAR(300));
        INSERT INTO @x
        SELECT r.ReleaseId, j.kind, j.path, j.url, j.ord, CONCAT(j.kind, ' cover of ', r.Title, ' by ', COALESCE(r.ArtistDisplay, b.Name))
          FROM OPENJSON(@p) WITH (band NVARCHAR(200), title NVARCHAR(400), date DATE, kind NVARCHAR(20), path NVARCHAR(400), url NVARCHAR(600), ord INT '$.order') j
          JOIN music.Bands b ON b.Name = j.band
          JOIN music.Releases r ON r.BandId = b.BandId AND r.Title = j.title AND r.ReleaseDate = j.date;
        MERGE music.Images AS t USING @x AS s ON t.ReleaseId = s.ReleaseId AND t.BlobPath = s.Path
        WHEN MATCHED THEN UPDATE SET Kind = s.Kind, PublicUrl = s.Url, SortOrder = s.SortOrder, AltText = s.Alt
        WHEN NOT MATCHED THEN INSERT (ReleaseId, Kind, BlobPath, PublicUrl, AltText, SortOrder) VALUES (s.ReleaseId, s.Kind, s.Path, s.Url, s.Alt, s.SortOrder);
        SELECT (SELECT COUNT(*) FROM OPENJSON(@p)) AS Sent, (SELECT COUNT(*) FROM @x) AS Linked;`,
        { p: [sql.NVarChar(sql.MAX), JSON.stringify(rows)] });
      return json({ ok: true, ...res[0] });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// ---------------------------------------------------------------------------
// Admin list page: releases by month, with the spreadsheet colours, and changing a colour.
//
// Colour   Status                     (as in the spreadsheet)
// none     NotPosted
// orange   Drafted (or Posted, not on the Sonos playlist yet)
// green    Posted + on the Sonos playlist
// red      DoNotPost
//
// A change made here is saved straight away and also remembered, so a later
// re-import from the spreadsheet doesn't undo it (kept in music.StatusOverrides). Once the change has been copied into the spreadsheet the
// override can be cleared (DELETE /api/manage/status-overrides).

const COLOURS = {
  none: { status: 'NotPosted', sonos: false },
  orange: { status: 'Drafted', sonos: false },
  green: { status: 'Posted', sonos: true },
  red: { status: 'DoNotPost', sonos: false }
};

function importContainer() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('import');
}
// Overrides are kept in music.StatusOverrides
async function readOverrides() {
  const rows = await query(`SELECT ReleaseId, Band, Title, CONVERT(char(10), ReleaseDate, 23) AS ReleaseDate, Colour, Status, OnSonos, ChangedAt FROM music.StatusOverrides`);
  const o = {};
  for (const r of rows) o[r.ReleaseId] = { id: r.ReleaseId, band: r.Band, title: r.Title, date: r.ReleaseDate, colour: r.Colour,
    status: r.Status, sonos: !!r.OnSonos, at: r.ChangedAt };
  return o;
}

async function applyStatusOverrides() {
  const o = await readOverrides();
  const list = Object.values(o);
  if (!list.length) return 0;
  await query(
    `UPDATE r SET Status = j.status, OnSonosPlaylist = j.sonos, UpdatedAt = SYSUTCDATETIME()
       FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
       JOIN OPENJSON(@p) WITH (band NVARCHAR(200), title NVARCHAR(400), date DATE, status NVARCHAR(20), sonos BIT) j
         ON j.band = b.Name AND j.title = r.Title AND j.date = r.ReleaseDate`,
    { p: [sql.NVarChar(sql.MAX), JSON.stringify(list)] });
  return list.length;
}

// GET /api/manage/month?m=6 -> every release in that month (all statuses)
app.http('adminMonth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/month',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const m = parseInt(request.query.get('m'), 10);
    if (!(m >= 1 && m <= 12)) return json({ error: 'Give ?m=1..12' }, 400);
    try {
      const rows = await query(
        `SELECT r.ReleaseId, r.ReleaseDay, r.ReleaseYear, b.Name AS Band, r.Title, r.ReleaseType,
                r.ChartPosition, r.ChartNote, r.TagNotes, r.Status, r.OnSonosPlaylist AS OnSonos,
                CASE WHEN r.WriteUp IS NULL OR r.WriteUp = '' THEN 0 ELSE 1 END AS HasWriteUp,
                (SELECT COUNT(*) FROM music.Images i WHERE i.ReleaseId = r.ReleaseId) AS ImageCount
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m
          ORDER BY r.ReleaseDay, r.ReleaseYear, b.Name`, { m: [sql.Int, m] });
      const o = await readOverrides();
      rows.forEach(r => { r.Changed = !!o[r.ReleaseId]; });
      return json({ month: m, rows });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/status  { "id": 123, "colour": "orange" | "green" | "none" | "red" }
app.http('adminStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/status',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const { id, colour } = await request.json();
      const c = COLOURS[colour];
      if (!c || !Number.isInteger(id)) return json({ ok: false, error: 'Give id and colour (none, orange, green, red).' }, 400);
      const rows = await query(
        `UPDATE r SET Status = @s, OnSonosPlaylist = @sonos, UpdatedAt = SYSUTCDATETIME()
           OUTPUT inserted.ReleaseId, inserted.Title, CONVERT(char(10), inserted.ReleaseDate, 23) AS ReleaseDate, inserted.Status
           FROM music.Releases r WHERE r.ReleaseId = @id`,
        { s: [sql.NVarChar(20), c.status], sonos: [sql.Bit, c.sonos], id: [sql.Int, id] });
      if (!rows.length) return json({ ok: false, error: 'Release not found.' }, 404);
      const band = (await query(`SELECT b.Name FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE r.ReleaseId = @id`,
        { id: [sql.Int, id] }))[0].Name;
      await query(`MERGE music.StatusOverrides AS t USING (SELECT @id AS ReleaseId) x ON t.ReleaseId = x.ReleaseId
        WHEN MATCHED THEN UPDATE SET Band = @b, Title = @t, ReleaseDate = @d, Colour = @c, Status = @s, OnSonos = @so, ChangedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (ReleaseId, Band, Title, ReleaseDate, Colour, Status, OnSonos, ChangedAt)
          VALUES (@id, @b, @t, @d, @c, @s, @so, SYSUTCDATETIME());`, {
        id: [sql.Int, id], b: [sql.NVarChar(200), band], t: [sql.NVarChar(400), rows[0].Title], d: [sql.Date, rows[0].ReleaseDate],
        c: [sql.NVarChar(10), colour], s: [sql.NVarChar(20), c.status], so: [sql.Bit, c.sonos] });
      return json({ ok: true, id, colour, status: c.status });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// GET /api/manage/status-overrides -> colour changes made on the site that aren't in the spreadsheet yet
// DELETE /api/manage/status-overrides?ids=1,2,3 (or no ids = all) -> forget them once the spreadsheet matches
app.http('adminStatusOverrides', {
  methods: ['GET', 'DELETE'],
  authLevel: 'anonymous',
  route: 'manage/status-overrides',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'GET') return json({ overrides: Object.values(await readOverrides()) });
      const ids = (request.query.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
      if (ids.length) await query(`DELETE music.StatusOverrides WHERE ReleaseId IN (SELECT value FROM OPENJSON(@j))`, { j: [sql.NVarChar(sql.MAX), JSON.stringify(ids)] });
      else await query(`DELETE music.StatusOverrides`);
      return json({ ok: true, remaining: Object.keys(await readOverrides()).length });
    } catch (err) {
      return failDetail(context, err);
    }
  }
});

// POST /api/manage/charts  { updates: [{ id, pos }], overwrite? } — sets UK chart peaks (by default only where none is set yet)
app.http('adminCharts', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/charts',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const ups = (b.updates || []).filter(u => Number.isInteger(u.id) && Number.isInteger(u.pos) && u.pos >= 1 && u.pos <= 200);
      if (!ups.length) return json({ ok: false, error: 'Nothing to update' }, 400);
      const r = await query(`UPDATE r SET r.ChartPosition = j.pos
          FROM music.Releases r JOIN OPENJSON(@j) WITH (id INT '$.id', pos INT '$.pos') j ON j.id = r.ReleaseId
         WHERE ${b.overwrite === true ? '1 = 1' : 'r.ChartPosition IS NULL'}; SELECT @@ROWCOUNT AS n;`, { j: [sql.NVarChar(sql.MAX), JSON.stringify(ups)] });
      return json({ ok: true, updated: r[0] ? r[0].n : null });
    } catch (err) { return failDetail(context, err); }
  }
});

// GET /api/manage/site-info -> sizes and counts for the Settings page (cached 10 minutes)
let siteInfoCache = null, siteInfoAt = 0;
app.http('adminSiteInfo', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/site-info',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (siteInfoCache && Date.now() - siteInfoAt < 10 * 60 * 1000 && !request.query.get('fresh')) return json(siteInfoCache);
      const out = {};
      try {
        const t = await query(`SELECT s.name + '.' + t.name AS TableName, SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS Rows,
                                      SUM(p.reserved_page_count) * 8 AS KB
                                 FROM sys.dm_db_partition_stats p JOIN sys.tables t ON t.object_id = p.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
                                GROUP BY s.name, t.name ORDER BY KB DESC`);
        t.forEach(r => { r.KB = Number(r.KB); r.Rows = Number(r.Rows); }); out.db = { kb: t.reduce((a, r) => a + r.KB, 0), tables: t };
      } catch (e) {
        const t = await query(`SELECT 'music.Releases' AS TableName, COUNT(*) AS Rows FROM music.Releases UNION ALL SELECT 'music.Bands', COUNT(*) FROM music.Bands
          UNION ALL SELECT 'music.Gigs', COUNT(*) FROM music.Gigs UNION ALL SELECT 'music.Images', COUNT(*) FROM music.Images`);
        out.db = { kb: null, tables: t, note: 'Run db/004-move-files-to-sql.sql to see the database size.' };
      }
      const svc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
      const tally = async (name) => {
        const c = { files: 0, bytes: 0, images: 0, imageBytes: 0, folders: {} };
        for await (const b of svc.getContainerClient(name).listBlobsFlat()) {
          const n = b.properties.contentLength || 0; c.files++; c.bytes += n;
          if (/\.(jpe?g|png|gif|webp|jfif)$/i.test(b.name)) { c.images++; c.imageBytes += n; }
          const top = b.name.includes('/') ? b.name.split('/')[0] : '(top level)';
          const f = c.folders[top] || (c.folders[top] = { files: 0, bytes: 0 }); f.files++; f.bytes += n;
        }
        return c;
      };
      out.media = await tally('media');
      out.import = await tally('import');
      const [c] = await query(`SELECT (SELECT COUNT(*) FROM music.Releases) AS Releases, (SELECT COUNT(*) FROM music.Bands) AS Bands,
        (SELECT COUNT(*) FROM music.Gigs) AS Gigs, (SELECT COUNT(*) FROM music.Images) AS ImageRows,
        (SELECT COUNT(*) FROM music.Releases WHERE ChartPosition IS NOT NULL) AS Charted`);
      out.counts = c;
      try {
        const [v] = await query(`DECLARE @today DATE = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE);
          SELECT (SELECT ISNULL(SUM(Views),0) FROM music.PageViews WHERE ViewDate = @today) AS Today,
                 (SELECT ISNULL(SUM(Views),0) FROM music.PageViews WHERE ViewDate >= DATEADD(day, -6, @today)) AS Week,
                 (SELECT ISNULL(SUM(Views),0) FROM music.PageViews WHERE ViewDate >= DATEADD(day, -29, @today)) AS Month,
                 (SELECT ISNULL(SUM(Views),0) FROM music.PageViews) AS AllTime`);
        out.traffic = v;
      } catch { out.traffic = null; }
      out.at = new Date().toISOString();
      siteInfoCache = out; siteInfoAt = Date.now();
      return json(out);
    } catch (err) { return failDetail(context, err); }
  }
});

// POST /api/manage/fix-names (owner) { titles: [{ id, title }], bands: [{ from, to }] }
// Corrects spelling of release titles, and band names (merging into an existing band of the right name).
app.http('adminFixNames', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/fix-names',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const titles = (b.titles || []).filter(t => Number.isInteger(t.id) && String(t.title || '').trim());
      let t = 0, bands = [];
      if (titles.length) t = (await query(`UPDATE r SET r.Title = j.title, r.UpdatedAt = SYSUTCDATETIME()
          FROM music.Releases r JOIN OPENJSON(@j) WITH (id INT, title NVARCHAR(400)) j ON j.id = r.ReleaseId;
        SELECT @@ROWCOUNT AS n;`, { j: [sql.NVarChar(sql.MAX), JSON.stringify(titles)] }))[0].n;
      for (const { from, to } of (b.bands || [])) {
        if (!from || !to) continue;
        const r = await query(`DECLARE @old INT = (SELECT BandId FROM music.Bands WHERE Name = @f), @new INT = (SELECT BandId FROM music.Bands WHERE Name = @t);
          IF @old IS NULL SELECT 'not found' AS result
          ELSE IF @new IS NULL BEGIN UPDATE music.Bands SET Name = @t, UpdatedAt = SYSUTCDATETIME() WHERE BandId = @old; SELECT 'renamed' AS result END
          ELSE BEGIN
            UPDATE music.Releases SET BandId = @new WHERE BandId = @old;
            UPDATE gb SET BandId = @new FROM music.GigBands gb WHERE gb.BandId = @old AND NOT EXISTS (SELECT 1 FROM music.GigBands x WHERE x.GigId = gb.GigId AND x.BandId = @new);
            DELETE music.GigBands WHERE BandId = @old;
            DELETE music.Bands WHERE BandId = @old; SELECT 'merged' AS result END`,
          { f: [sql.NVarChar(200), from], t: [sql.NVarChar(200), to] });
        bands.push(`${from} → ${to}: ${r[0].result}`);
      }
      return json({ ok: true, titles: t, bands });
    } catch (err) { return failDetail(context, err); }
  }
});

// POST /api/manage/release-fix (owner) { fixes: [{ id, type?, date?, region?, chart? }] } — corrects single fields on releases
// (region: 'UK' | 'US' | 'Japan' | 'Australia' | null; chart: number or null to clear)
app.http('adminReleaseFix', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/release-fix',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json(); const done = [];
      for (const f of (b.fixes || [])) {
        if (!Number.isInteger(f.id)) continue;
        const sets = [], p = { id: [sql.Int, f.id] };
        if (f.type) { sets.push('ReleaseType = @type'); p.type = [sql.NVarChar(20), f.type]; }
        if (f.date) { sets.push('ReleaseDate = @date'); p.date = [sql.Date, f.date]; }
        if ('region' in f) { sets.push('ReleaseRegion = @region'); p.region = [sql.NVarChar(10), f.region || null]; }
        if ('chart' in f) { sets.push('ChartPosition = @chart'); p.chart = [sql.Int, f.chart || null]; }
        if (!sets.length) continue;
        const r = await query(`UPDATE music.Releases SET ${sets.join(', ')}, UpdatedAt = SYSUTCDATETIME() WHERE ReleaseId = @id; SELECT @@ROWCOUNT AS n`, p);
        done.push({ id: f.id, ok: !!(r[0] && r[0].n) });
      }
      return json({ ok: true, done });
    } catch (err) { return failDetail(context, err); }
  }
});
