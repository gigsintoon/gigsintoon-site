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
  const blob = svc.getContainerClient('import').getBlobClient(name);
  const buf = await blob.downloadToBuffer();
  return JSON.parse(buf.toString('utf8'));
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

DELETE i FROM music.Images i JOIN @map m ON m.ReleaseId = i.ReleaseId;

INSERT INTO music.Images (ReleaseId, Kind, BlobPath, PublicUrl, AltText, SortOrder)
SELECT m.ReleaseId, img.Kind, img.Path, @base + img.UrlPath,
       CONCAT(img.Kind, ' cover of ', r.Title, ' by ', COALESCE(r.ArtistDisplay, r.Band)), img.SortOrder
FROM @rows r JOIN @map m ON m.RowNo = r.RowNo
CROSS APPLY OPENJSON(r.Images) WITH (Kind NVARCHAR(20) '$.kind', Path NVARCHAR(400) '$.path',
  UrlPath NVARCHAR(600) '$.urlPath', SortOrder INT '$.order') img;

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
      const result = await query(IMPORT_SQL, {
        payload: [sql.NVarChar(sql.MAX), JSON.stringify(rows)],
        base: [sql.NVarChar(400), base]
      });
      return json({ ok: true, file, ...result[0] });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: err.message }, 500);
    }
  }
});
