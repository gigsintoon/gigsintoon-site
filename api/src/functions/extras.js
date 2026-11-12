const { app } = require('@azure/functions');
const crypto = require('crypto');
const { sql, query, json, fail } = require('../db');
const { isOwner } = require('../auth');

// A rough per-visitor limit (5 messages an hour) without storing anyone's IP address
const recent = new Map();
function tooMany(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const key = crypto.createHash('sha256').update(ip + new Date().toISOString().slice(0, 13)).digest('hex');
  const n = (recent.get(key) || 0) + 1;
  recent.set(key, n);
  if (recent.size > 5000) recent.clear();
  return n > 5;
}

// POST /api/contact {name, email, topic, message, website(honeypot)}
app.http('contact', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'contact',
  handler: async (request, context) => {
    try {
      const b = await request.json().catch(() => ({}));
      if (b.website) return json({ ok: true });                       // bots fill the hidden field
      const name = String(b.name || '').trim().slice(0, 100);
      const email = String(b.email || '').trim().slice(0, 200);
      const topic = String(b.topic || 'General').trim().slice(0, 50);
      const message = String(b.message || '').trim().slice(0, 4000);
      if (message.length < 5) return json({ ok: false, error: 'Please write a message.' }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'That email address doesn’t look right.' }, 400);
      if ((message.match(/https?:\/\//g) || []).length > 3) return json({ ok: false, error: 'Please include fewer links.' }, 400);
      if (tooMany(request)) return json({ ok: false, error: 'Thanks – please try again a bit later.' }, 429);
      const at = new Date();
      const id = at.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
      await query(`INSERT music.Messages (MessageId, ReceivedAt, Name, Email, Topic, Body) VALUES (@id, @at, @n, @e, @t, @b)`, {
        id: [sql.NVarChar(40), id], at: [sql.DateTime2, at], n: [sql.NVarChar(100), name || null], e: [sql.NVarChar(200), email || null],
        t: [sql.NVarChar(50), topic], b: [sql.NVarChar(4000), message] });
      return json({ ok: true });
    } catch (err) {
      return fail(context, err);
    }
  }
});

const msgOut = m => ({ id: m.MessageId, at: m.ReceivedAt, name: m.Name, email: m.Email, topic: m.Topic, message: m.Body,
  read: !!m.IsRead, deletedAt: m.DeletedAt || undefined });

// GET /api/manage/messages -> { messages, bin } newest first
// POST /api/manage/messages {id, read} | {id, action: delete | restore | purge}
app.http('adminMessages', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/messages',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'POST') {
        const b = await request.json();
        const id = [sql.NVarChar(40), String(b.id || '')];
        const sqlText = b.action === 'purge' ? `DELETE music.Messages WHERE MessageId = @id`
          : b.action === 'delete' ? `UPDATE music.Messages SET DeletedAt = SYSUTCDATETIME() WHERE MessageId = @id`
          : b.action === 'restore' ? `UPDATE music.Messages SET DeletedAt = NULL WHERE MessageId = @id`
          : `UPDATE music.Messages SET IsRead = @r WHERE MessageId = @id`;
        await query(sqlText, { id, r: [sql.Bit, !!b.read] });
        return json({ ok: true });
      }
      // Messages in the bin are removed for good 30 days after they were deleted
      await query(`DELETE music.Messages WHERE DeletedAt < DATEADD(day, -30, SYSUTCDATETIME())`);
      const all = (await query(`SELECT * FROM music.Messages ORDER BY ReceivedAt DESC`)).map(msgOut);
      return json({ messages: all.filter(m => !m.deletedAt), bin: all.filter(m => m.deletedAt) });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/manage/bands -> every band name (for the "add a release" form)
app.http('adminBands', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/bands',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const rows = await query('SELECT Name FROM music.Bands ORDER BY Name');
      return json({ bands: rows.map(r => r.Name) });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET/POST/DELETE /api/manage/site-additions -> releases added through the website's form, so they can be
// copied into the spreadsheet and the laptop folders. POST {entry} adds, DELETE ?ids= clears copied ones.
app.http('adminSiteAdditions', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'manage/site-additions',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'POST') {
        const e = await request.json();
        await query(`INSERT music.SiteAdditions (ReleaseId, Entry, AddedAt) VALUES (@r, @e, SYSUTCDATETIME())`,
          { r: [sql.Int, Number.isInteger(e.releaseId) ? e.releaseId : null], e: [sql.NVarChar(sql.MAX), JSON.stringify(e)] });
        const n = await query(`SELECT COUNT(*) AS n FROM music.SiteAdditions`);
        return json({ ok: true, count: n[0].n });
      }
      if (request.method === 'DELETE') {
        const ids = (request.query.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
        if (ids.length) await query(`DELETE music.SiteAdditions WHERE ReleaseId IN (SELECT value FROM OPENJSON(@j))`, { j: [sql.NVarChar(sql.MAX), JSON.stringify(ids)] });
        else await query(`DELETE music.SiteAdditions`);
        const n = await query(`SELECT COUNT(*) AS n FROM music.SiteAdditions`);
        return json({ ok: true, remaining: n[0].n });
      }
      const rows = await query(`SELECT Entry, AddedAt FROM music.SiteAdditions ORDER BY AdditionId`);
      return json({ additions: rows.map(r => ({ ...JSON.parse(r.Entry), at: r.AddedAt })) });
    } catch (err) {
      return fail(context, err);
    }
  }
});

const todoOut = t => ({ id: t.TodoId, title: t.Title, detail: t.Detail || '', owner: t.Owner, done: !!t.Done,
  answer: t.Answer || undefined, created: t.CreatedAt, doneAt: t.DoneAt });

// GET/POST /api/manage/todos  – the admin to-do list
// POST {action:'add', title, detail, owner} | {action:'update', id, done?, title?, detail?, owner?, answer?} | {action:'delete', id}
app.http('adminTodos', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/todos',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const list = async () => (await query(`SELECT * FROM music.Todos ORDER BY CreatedAt`)).map(todoOut);
    try {
      if (request.method === 'GET') return json({ todos: await list() });
      const b = await request.json();
      if (b.action === 'add') {
        if (!String(b.title || '').trim()) return json({ ok: false, error: 'Give it a title.' }, 400);
        await query(`INSERT music.Todos (TodoId, Title, Detail, Owner, CreatedAt) VALUES (@id, @t, @d, @o, SYSUTCDATETIME())`, {
          id: [sql.NVarChar(16), crypto.randomBytes(4).toString('hex')], t: [sql.NVarChar(300), String(b.title).trim().slice(0, 300)],
          d: [sql.NVarChar(3000), String(b.detail || '').trim().slice(0, 3000)], o: [sql.NVarChar(10), b.owner === 'Claude' ? 'Claude' : 'Michael'] });
      } else if (b.action === 'update') {
        const sets = [], p = { id: [sql.NVarChar(16), String(b.id || '')] };
        if ('done' in b) { sets.push('Done = @done, DoneAt = CASE WHEN @done = 1 THEN SYSUTCDATETIME() ELSE NULL END'); p.done = [sql.Bit, !!b.done]; }
        for (const [k, col, n] of [['title', 'Title', 300], ['detail', 'Detail', 3000], ['owner', 'Owner', 10], ['answer', 'Answer', 3000]]) {
          if (k in b) { sets.push(`${col} = @${k}`); p[k] = [sql.NVarChar(n), String(b[k] ?? '').slice(0, n)]; }
        }
        if (!sets.length) return json({ ok: false, error: 'Nothing to change' }, 400);
        const r = await query(`UPDATE music.Todos SET ${sets.join(', ')} WHERE TodoId = @id; SELECT @@ROWCOUNT AS n`, p);
        if (!r[0] || !r[0].n) return json({ ok: false, error: 'Not found' }, 404);
      } else if (b.action === 'delete') {
        await query(`DELETE music.Todos WHERE TodoId = @id`, { id: [sql.NVarChar(16), String(b.id || '')] });
      } else return json({ ok: false, error: 'Unknown action' }, 400);
      return json({ ok: true, todos: await list() });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/manage/report-key (owner) -> makes a new key for the weekly report and returns it once.
// Only a hash of it is kept, in music.Settings.
app.http('adminReportKey', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/report-key',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const key = crypto.randomBytes(24).toString('hex');
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      await query(`MERGE music.Settings AS t USING (SELECT N'ReportKeyHash' AS Name) s ON t.Name = s.Name
        WHEN MATCHED THEN UPDATE SET Value = @v, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (Name, Value, UpdatedAt) VALUES (s.Name, @v, SYSUTCDATETIME());`, { v: [sql.NVarChar(sql.MAX), hash] });
      return json({ ok: true, key });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET/POST /api/manage/remembering (owner) body: [{ month, day, name, year, age, note, bands:[...] }] -> replaces the list
app.http('manageRemembering', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/remembering',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'GET') {
        const rows = await query(`SELECT * FROM music.Remembering ORDER BY DeathMonth, DeathDay`);
        return json(rows.map(r => ({ month: r.DeathMonth, day: r.DeathDay, name: r.Name, year: r.DeathYear, age: r.Age, note: r.Note, bands: JSON.parse(r.Bands || '[]') })));
      }
      const b = await request.json();
      if (!Array.isArray(b)) return json({ ok: false, error: 'Send a list' }, 400);
      const clean = b.filter(r => r.name && r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= 31)
        .map(r => ({ month: +r.month, day: +r.day, name: String(r.name).slice(0, 100), year: +r.year || null, age: +r.age || null,
                     note: r.note ? String(r.note).slice(0, 300) : null, bands: JSON.stringify((r.bands || []).map(String).slice(0, 8)) }));
      await query(`DELETE music.Remembering;
        INSERT music.Remembering (DeathMonth, DeathDay, Name, DeathYear, Age, Note, Bands)
        SELECT month, day, name, year, age, note, bands FROM OPENJSON(@j)
          WITH (month TINYINT, day TINYINT, name NVARCHAR(100), year INT, age INT, note NVARCHAR(300), bands NVARCHAR(800))`,
        { j: [sql.NVarChar(sql.MAX), JSON.stringify(clean)] });
      return json({ ok: true, count: clean.length });
    } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
  }
});
