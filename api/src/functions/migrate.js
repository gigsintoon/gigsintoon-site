const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');
const { sql, query, json } = require('../db');
const { isOwner } = require('../auth');

// POST /api/manage/migrate-files (owner) — one-off copy of the data that used to be kept as files in the
// "import" storage container into the SQL tables made by db/004-move-files-to-sql.sql. Safe to run again:
// anything already in the database is left alone. The old files are kept as a backup.
const container = () => BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('import');
async function readJson(name, fallback) {
  const b = container().getBlockBlobClient(name);
  if (!(await b.exists())) return fallback;
  try { return JSON.parse((await b.downloadToBuffer()).toString('utf8')); } catch { return fallback; }
}
const J = v => [sql.NVarChar(sql.MAX), JSON.stringify(v)];

app.http('adminMigrateFiles', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/migrate-files',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const done = {};
    const step = async (name, fn) => { try { done[name] = await fn(); } catch (e) { context.error(e); done[name] = 'ERROR: ' + e.message; } };

    await step('messages', async () => {
      const list = [];
      for await (const b of container().listBlobsFlat({ prefix: 'contact/' })) { const m = await readJson(b.name, null); if (m && m.id) list.push(m); }
      if (!list.length) return 0;
      const r = await query(`INSERT music.Messages (MessageId, ReceivedAt, Name, Email, Topic, Body, IsRead, DeletedAt)
        SELECT j.id, j.at, NULLIF(j.name, ''), NULLIF(j.email, ''), j.topic, j.message, ISNULL(j.[read], 0), j.deletedAt
          FROM OPENJSON(@j) WITH (id NVARCHAR(40), at DATETIME2, name NVARCHAR(100), email NVARCHAR(200), topic NVARCHAR(50),
                                  message NVARCHAR(4000), [read] BIT, deletedAt DATETIME2) j
         WHERE NOT EXISTS (SELECT 1 FROM music.Messages m WHERE m.MessageId = j.id); SELECT @@ROWCOUNT AS n;`, { j: J(list) });
      return r[0].n;
    });
    await step('todos', async () => {
      const list = await readJson('todos.json', []);
      if (!list.length) return 0;
      const r = await query(`INSERT music.Todos (TodoId, Title, Detail, Owner, Done, Answer, CreatedAt, DoneAt)
        SELECT j.id, j.title, j.detail, j.owner, ISNULL(j.done, 0), j.answer, ISNULL(j.created, SYSUTCDATETIME()), j.doneAt
          FROM OPENJSON(@j) WITH (id NVARCHAR(16), title NVARCHAR(300), detail NVARCHAR(3000), owner NVARCHAR(10), done BIT,
                                  answer NVARCHAR(3000), created DATETIME2, doneAt DATETIME2) j
         WHERE NOT EXISTS (SELECT 1 FROM music.Todos t WHERE t.TodoId = j.id); SELECT @@ROWCOUNT AS n;`, { j: J(list) });
      return r[0].n;
    });
    await step('siteAdditions', async () => {
      const list = await readJson('site-additions.json', []);
      const have = (await query(`SELECT COUNT(*) AS n FROM music.SiteAdditions`))[0].n;
      if (!list.length || have) return have ? `skipped (${have} already there)` : 0;
      for (const e of list) await query(`INSERT music.SiteAdditions (ReleaseId, Entry, AddedAt) VALUES (@r, @e, @a)`,
        { r: [sql.Int, Number.isInteger(e.releaseId) ? e.releaseId : null], e: [sql.NVarChar(sql.MAX), JSON.stringify(e)], a: [sql.DateTime2, new Date(e.at || Date.now())] });
      return list.length;
    });
    await step('statusOverrides', async () => {
      const list = Object.values(await readJson('status-overrides.json', {}));
      if (!list.length) return 0;
      const r = await query(`INSERT music.StatusOverrides (ReleaseId, Band, Title, ReleaseDate, Colour, Status, OnSonos, ChangedAt)
        SELECT j.id, j.band, j.title, j.date, j.colour, j.status, ISNULL(j.sonos, 0), ISNULL(j.at, SYSUTCDATETIME())
          FROM OPENJSON(@j) WITH (id INT, band NVARCHAR(200), title NVARCHAR(400), date DATE, colour NVARCHAR(10), status NVARCHAR(20), sonos BIT, at DATETIME2) j
         WHERE NOT EXISTS (SELECT 1 FROM music.StatusOverrides o WHERE o.ReleaseId = j.id); SELECT @@ROWCOUNT AS n;`, { j: J(list) });
      return r[0].n;
    });
    await step('gigExtras', async () => {
      const ex = await readJson('gig-extras.json', {});
      const list = Object.entries(ex).map(([id, x]) => ({ id: +id, setlist: x.setlist ? JSON.stringify(x.setlist) : null, setlistUrl: x.setlistUrl || null, playlistUrl: x.playlistUrl || null }));
      if (!list.length) return 0;
      const r = await query(`UPDATE g SET SetlistJson = COALESCE(g.SetlistJson, j.setlist), SetlistUrl = COALESCE(g.SetlistUrl, j.setlistUrl),
                                  PlaylistUrl = COALESCE(g.PlaylistUrl, j.playlistUrl)
          FROM music.Gigs g JOIN OPENJSON(@j) WITH (id INT, setlist NVARCHAR(MAX), setlistUrl NVARCHAR(400), playlistUrl NVARCHAR(400)) j ON j.id = g.GigId;
        SELECT @@ROWCOUNT AS n;`, { j: J(list) });
      return r[0].n;
    });
    await step('guess', async () => {
      let weeks = 0, scores = 0;
      for await (const b of container().listBlobsFlat({ prefix: 'guess/' })) {
        const m = b.name.match(/^guess\/(.+?)(-board)?\.json$/); if (!m) continue;
        const data = await readJson(b.name, null); if (!data) continue;
        if (m[2]) {
          const rows = data.map(e => ({ id: e.id, name: e.name, guesses: e.guesses, ms: e.ms, at: e.at }));
          if (!rows.length) continue;
          const r = await query(`INSERT music.GuessScores (ScoreId, Week, Name, Guesses, Ms, CreatedAt)
            SELECT j.id, @w, j.name, j.guesses, j.ms, ISNULL(j.at, SYSUTCDATETIME())
              FROM OPENJSON(@j) WITH (id NVARCHAR(20), name NVARCHAR(24), guesses INT, ms INT, at DATETIME2) j
             WHERE NOT EXISTS (SELECT 1 FROM music.GuessScores s WHERE s.ScoreId = j.id); SELECT @@ROWCOUNT AS n;`, { w: [sql.NVarChar(10), m[1]], j: J(rows) });
          scores += r[0].n;
        } else {
          const r = await query(`IF NOT EXISTS (SELECT 1 FROM music.GuessWeeks WHERE Week = @w)
              INSERT music.GuessWeeks (Week, Tries, Correct) VALUES (@w, @t, @c); SELECT @@ROWCOUNT AS n;`,
            { w: [sql.NVarChar(10), m[1]], t: [sql.Int, data.tries || 0], c: [sql.Int, data.correct || 0] });
          weeks += r[0].n;
        }
      }
      return { weeks, scores };
    });
    await step('remembering', async () => {
      const have = (await query(`SELECT COUNT(*) AS n FROM music.Remembering`))[0].n;
      const list = await readJson('remembering.json', []);
      if (have || !list.length) return have ? `skipped (${have} already there)` : 0;
      await query(`INSERT music.Remembering (DeathMonth, DeathDay, Name, DeathYear, Age, Note, Bands)
        SELECT month, day, name, year, age, note, bands FROM OPENJSON(@j)
          WITH (month TINYINT, day TINYINT, name NVARCHAR(100), year INT, age INT, note NVARCHAR(300), bands NVARCHAR(MAX) AS JSON)`, { j: J(list) });
      return list.length;
    });
    await step('favourites', async () => {
      const have = (await query(`SELECT COUNT(*) AS n FROM music.FavouriteYears`))[0].n;
      if (have) return `skipped (${have} years already there)`;
      const fav = require('../favourites.json');
      let albums = 0;
      for (const y of fav.years) {
        await query(`INSERT music.FavouriteYears (Year, Title, Note, Kind, Ranked) VALUES (@y, @t, @n, @k, @r)`, {
          y: [sql.Int, y.year], t: [sql.NVarChar(200), y.title], n: [sql.NVarChar(500), y.note || null], k: [sql.NVarChar(20), y.kind || null], r: [sql.Bit, !!y.ranked] });
        const list = (y.albums || []).map((a, i) => ({ ...a, order: i + 1, year: y.year }));
        if (list.length) await query(`INSERT music.FavouriteAlbums (Year, SortOrder, Rank, Artist, Title, Note, CoverUrl)
          SELECT year, [order], rank, artist, title, note, cover FROM OPENJSON(@j)
            WITH (year INT, [order] INT, rank INT, artist NVARCHAR(200), title NVARCHAR(400), note NVARCHAR(1000), cover NVARCHAR(800))`, { j: J(list) });
        albums += list.length;
      }
      return { years: fav.years.length, albums };
    });
    await step('reportKey', async () => {
      const have = await query(`SELECT 1 AS x FROM music.Settings WHERE Name = N'ReportKeyHash'`);
      if (have.length) return 'already set';
      const b = container().getBlockBlobClient('report-key.txt');
      if (!(await b.exists())) return 'no key yet';
      const key = (await b.downloadToBuffer()).toString('utf8').trim();
      await query(`INSERT music.Settings (Name, Value, UpdatedAt) VALUES (N'ReportKeyHash', @v, SYSUTCDATETIME())`,
        { v: [sql.NVarChar(sql.MAX), crypto.createHash('sha256').update(key).digest('hex')] });
      return 'moved (stored as a hash)';
    });
    return json({ ok: !Object.values(done).some(v => String(v).startsWith('ERROR')), done });
  }
});
