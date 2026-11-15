const { app } = require('@azure/functions');
const { sql, query, json } = require('../db');
const { isOwner, prelaunch, prelaunchResponse } = require('../auth');

// GET /api/links?ids=1,2,3 -> { links: { "1": { apple, deezer } } }  direct Apple Music / Deezer pages for releases
// (table made by db/005; until then this just returns nothing, so no listen links show)
app.http('releaseLinks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'links',
  handler: async (request) => {
    if (prelaunch(request)) return prelaunchResponse();
    const ids = String(request.query.get('ids') || '').split(',').map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 300);
    if (!ids.length) return json({ links: {} });
    const rows = await query(`SELECT ReleaseId, AppleUrl, DeezerUrl FROM music.ReleaseLinks
                               WHERE ReleaseId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`,
      { ids: [sql.NVarChar(sql.MAX), JSON.stringify(ids)] }).catch(() => []);
    const links = {};
    for (const r of rows) links[r.ReleaseId] = { apple: r.AppleUrl || null, deezer: r.DeezerUrl || null };
    return json({ links });
  }
});

// POST /api/manage/release-links (owner)  [{ id, apple, deezer }]  – saves or replaces direct links
app.http('adminReleaseLinks', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/release-links',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const ok = u => (typeof u === 'string' && /^https:\/\/(music\.apple\.com|www\.deezer\.com)\//.test(u)) ? u.slice(0, 400) : null;
      const rows = (await request.json()).filter(x => Number.isInteger(x.id)).map(x => ({ id: x.id, apple: ok(x.apple), deezer: ok(x.deezer) }));
      const r = await query(`MERGE music.ReleaseLinks AS t
          USING (SELECT * FROM OPENJSON(@p) WITH (id INT, apple NVARCHAR(400), deezer NVARCHAR(400))) AS s
             ON t.ReleaseId = s.id
          WHEN MATCHED THEN UPDATE SET AppleUrl = s.apple, DeezerUrl = s.deezer, UpdatedAt = SYSUTCDATETIME()
          WHEN NOT MATCHED AND EXISTS (SELECT 1 FROM music.Releases x WHERE x.ReleaseId = s.id)
               THEN INSERT (ReleaseId, AppleUrl, DeezerUrl) VALUES (s.id, s.apple, s.deezer);
          SELECT @@ROWCOUNT AS n;`, { p: [sql.NVarChar(sql.MAX), JSON.stringify(rows)] });
      return json({ ok: true, saved: r[0] ? r[0].n : 0 });
    } catch (err) { context.error(err); return json({ ok: false, error: /Invalid object name/.test(err.message) ? 'needs db/005' : err.message }, 500); }
  }
});

// POST /api/manage/writeup-replace (owner) { find, replace, confirm }  – swaps a handle/phrase in every write-up
// (case-insensitive, whole tag only). Without confirm:true it only lists what would change.
app.http('adminWriteupReplace', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/writeup-replace',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const find = String(b.find || '').trim(), rep = String(b.replace ?? '');
      if (find.length < 3) return json({ ok: false, error: 'Give find (3+ characters)' }, 400);
      const rows = await query(`SELECT ReleaseId, WriteUp FROM music.Releases WHERE WriteUp LIKE @p`, { p: [sql.NVarChar(400), '%' + find + '%'] });
      const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'gi');
      const changes = rows.map(r => ({ id: r.ReleaseId, before: r.WriteUp, after: r.WriteUp.replace(re, rep) })).filter(c => c.after !== c.before);
      if (b.confirm === true) {
        for (const c of changes) await query(`UPDATE music.Releases SET WriteUp = @w, UpdatedAt = SYSUTCDATETIME() WHERE ReleaseId = @id`,
          { w: [sql.NVarChar(sql.MAX), c.after], id: [sql.Int, c.id] });
      }
      return json({ ok: true, confirm: b.confirm === true, count: changes.length, changes: changes.map(c => ({ id: c.id, after: c.after.slice(0, 200) })) });
    } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
  }
});

// POST /api/manage/deezer-fill (owner) { ids:[...], save:false }
// Looks each release up on Deezer's public search and returns the confident matches; with save:true it stores them
// (keeping any Apple link already there). Albums/EPs/compilations/live only match a Deezer album of the same name;
// singles can also fall back to the song itself when Deezer has no separate single.
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const cleanTitle = s => String(s || '').replace(/\s*[([][^)\]]*\b(?:remaster(?:ed)?|deluxe|expanded|anniversary|explicit|single|ep|edit|version|bonus)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+(?:single|ep|remaster.*)$/i, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function dz(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.deezer.com' + path);
    const j = await r.json().catch(() => ({}));
    if (j.error && j.error.code === 4) { await sleep(1500); continue; }   // quota: back off
    return j;
  }
  return {};
}
async function deezerMatch(rel) {
  const a = norm(rel.Band), t = norm(cleanTitle(rel.Title));
  if (!a || !t) return null;
  const isSingle = rel.ReleaseType === 'Single';
  const plain = encodeURIComponent(rel.Band + ' ' + cleanTitle(rel.Title));
  const adv = await dz(`/search/album?q=${encodeURIComponent(`artist:"${rel.Band}" album:"${cleanTitle(rel.Title)}"`)}&limit=25`);
  const pl = await dz(`/search/album?q=${plain}&limit=50`);
  const albums = [...(adv.data || []), ...(pl.data || [])].filter(x => norm(x.artist && x.artist.name) === a && norm(cleanTitle(x.title)) === t)
    .filter(x => isSingle ? true : x.record_type !== 'single');
  albums.sort((x, y) => (isSingle ? (y.record_type === 'single') - (x.record_type === 'single') : (y.nb_tracks || 0) - (x.nb_tracks || 0)));
  if (albums[0]) return { url: `https://www.deezer.com/album/${albums[0].id}`, how: `album "${albums[0].title}" (${albums[0].record_type}, ${albums[0].nb_tracks || '?'} tracks)` };
  if (!isSingle) return null;
  const tr = await dz(`/search/track?q=${plain}&limit=50`);
  const mine = (tr.data || []).filter(x => norm(x.artist && x.artist.name) === a);
  // a single Deezer only has inside another release: the single's own page if it shows up via its songs, else the song
  const asAlbum = mine.find(x => x.album && norm(cleanTitle(x.album.title)) === t);
  if (asAlbum) return { url: `https://www.deezer.com/album/${asAlbum.album.id}`, how: `album "${asAlbum.album.title}" (found via its songs)` };
  const songs = mine.filter(x => norm(cleanTitle(x.title_short || x.title)) === t);
  if (songs[0]) return { url: `https://www.deezer.com/track/${songs[0].id}`, how: `song on "${songs[0].album && songs[0].album.title}"` };
  return null;
}
app.http('adminDeezerFill', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/deezer-fill',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const ids = (b.ids || []).map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 40);
      const rels = await query(`SELECT r.ReleaseId, r.Title, r.ReleaseType, b.Name AS Band, l.AppleUrl, l.DeezerUrl
          FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId LEFT JOIN music.ReleaseLinks l ON l.ReleaseId = r.ReleaseId
         WHERE r.ReleaseId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))`, { ids: [sql.NVarChar(sql.MAX), JSON.stringify(ids)] });
      const found = [], missed = [];
      for (const r of rels) {
        if (r.DeezerUrl && !b.force) continue;
        const m = await deezerMatch(r).catch(() => null);
        if (m) found.push({ id: r.ReleaseId, band: r.Band, title: r.Title, type: r.ReleaseType, apple: r.AppleUrl, ...m });
        else missed.push({ id: r.ReleaseId, band: r.Band, title: r.Title, type: r.ReleaseType });
        await sleep(120);
      }
      let saved = 0;
      if (b.save && found.length) {
        const rr = await query(`MERGE music.ReleaseLinks AS t
            USING (SELECT * FROM OPENJSON(@p) WITH (id INT, apple NVARCHAR(400), url NVARCHAR(400))) AS s ON t.ReleaseId = s.id
            WHEN MATCHED THEN UPDATE SET DeezerUrl = s.url, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (ReleaseId, AppleUrl, DeezerUrl) VALUES (s.id, s.apple, s.url);
            SELECT @@ROWCOUNT AS n;`, { p: [sql.NVarChar(sql.MAX), JSON.stringify(found)] });
        saved = rr[0] ? rr[0].n : 0;
      }
      return json({ ok: true, found, missed, saved });
    } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
  }
});
