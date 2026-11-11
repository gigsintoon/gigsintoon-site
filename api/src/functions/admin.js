const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { sql, query, json } = require('../db');

// Only signed-in users with the "owner" role may use admin functions.
// (staticwebapp.config.json already enforces this; this is a second check.)
function isOwner(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return false;
  try {
    const principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return (principal.userRoles || []).includes('owner');
  } catch {
    return false;
  }
}

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
  OnSonos BIT, Images NVARCHAR(MAX));

INSERT INTO @rows
SELECT j.[key] + 0, v.Band, v.ArtistDisplay, v.Title, v.ReleaseType, v.ReleaseDate, v.ChartPosition,
       v.ChartNote, v.Label, v.WriteUp, v.TagNotes, v.Status, v.OnSonos, v.Images
FROM OPENJSON(@payload) j
CROSS APPLY OPENJSON(j.value) WITH (
  Band NVARCHAR(200) '$.band', ArtistDisplay NVARCHAR(300) '$.artistDisplay', Title NVARCHAR(400) '$.title',
  ReleaseType NVARCHAR(20) '$.type', ReleaseDate DATE '$.date', ChartPosition INT '$.chart',
  ChartNote NVARCHAR(200) '$.chartNote', Label NVARCHAR(200) '$.label', WriteUp NVARCHAR(MAX) '$.writeUp',
  TagNotes NVARCHAR(500) '$.tagNotes', Status NVARCHAR(20) '$.status', OnSonos BIT '$.onSonos',
  Images NVARCHAR(MAX) '$.images' AS JSON) v;

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
  TagNotes = s.TagNotes, Status = s.Status, OnSonosPlaylist = s.OnSonos, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (BandId, ArtistDisplay, Title, ReleaseType, ReleaseDate, ChartPosition, ChartNote, Label, WriteUp, TagNotes, Status, OnSonosPlaylist)
  VALUES (s.BandId, s.ArtistDisplay, s.Title, s.ReleaseType, s.ReleaseDate, s.ChartPosition, s.ChartNote,
          s.Label, s.WriteUp, s.TagNotes, s.Status, s.OnSonos)
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
      const rows = await readImportFile(file);
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
      const buf = Buffer.from(await request.arrayBuffer());
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
      const paths = (body.paths || []).map(cleanPath).filter(Boolean);
      const inUse = new Set((await query(`SELECT BlobPath FROM music.Images`)).map(r => r.BlobPath));
      const c = mediaContainer();
      const result = { deleted: [], wouldDelete: [], notFound: [], keptInUse: [] };
      for (const p of paths) {
        if (inUse.has(p)) { result.keptInUse.push(p); continue; }
        const blob = c.getBlobClient(p);
        if (!(await blob.exists())) { result.notFound.push(p); continue; }
        if (body.confirm === true) { await blob.delete(); result.deleted.push(p); } else result.wouldDelete.push(p);
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
