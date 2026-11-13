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
