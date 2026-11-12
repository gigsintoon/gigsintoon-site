const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');
const { query, json, fail } = require('../db');
const { isOwner } = require('../auth');

// Contact messages and the log of releases added on the site are kept as JSON files in the
// "import" storage container (the site's database login can't create tables).
function container() {
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('import');
}
async function readJson(name, fallback) {
  const b = container().getBlockBlobClient(name);
  if (!(await b.exists())) return fallback;
  return JSON.parse((await b.downloadToBuffer()).toString('utf8') || 'null') ?? fallback;
}
async function writeJson(name, data) {
  const text = JSON.stringify(data, null, 1);
  await container().getBlockBlobClient(name).upload(text, Buffer.byteLength(text), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

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
      const at = new Date().toISOString();
      const id = at.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
      await writeJson(`contact/${id}.json`, { id, at, name, email, topic, message, read: false });
      return json({ ok: true });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/manage/messages            -> all messages, newest first
// POST /api/manage/messages {id, read} -> mark read/unread
app.http('adminMessages', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/messages',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'POST') {
        const b = await request.json();
        const name = `contact/${String(b.id).replace(/[^\w-]/g, '')}.json`;
        const m = await readJson(name, null);
        if (!m) return json({ ok: false, error: 'Not found' }, 404);
        if (b.action === 'purge') { await container().getBlockBlobClient(name).deleteIfExists(); return json({ ok: true }); }
        if (b.action === 'delete') m.deletedAt = new Date().toISOString();
        else if (b.action === 'restore') delete m.deletedAt;
        else m.read = !!b.read;
        await writeJson(name, m);
        return json({ ok: true });
      }
      // Messages in the bin are removed for good 30 days after they were deleted
      const out = [], cutoff = Date.now() - 30 * 86400000;
      for await (const blob of container().listBlobsFlat({ prefix: 'contact/' })) {
        const m = await readJson(blob.name, null);
        if (m && m.deletedAt && Date.parse(m.deletedAt) < cutoff) { await container().getBlockBlobClient(blob.name).deleteIfExists(); continue; }
        out.push(m);
      }
      out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
      const all = out.filter(Boolean);
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

// GET/POST /api/manage/site-additions -> releases added through the website's form, so they can be
// copied into the spreadsheet and the laptop folders. POST {entry} appends, DELETE ?ids= clears copied ones.
app.http('adminSiteAdditions', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'manage/site-additions',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const list = await readJson('site-additions.json', []);
      if (request.method === 'POST') {
        const e = await request.json();
        list.push({ ...e, at: new Date().toISOString() });
        await writeJson('site-additions.json', list);
        return json({ ok: true, count: list.length });
      }
      if (request.method === 'DELETE') {
        const ids = (request.query.get('ids') || '').split(',').filter(Boolean);
        const keep = ids.length ? list.filter(x => !ids.includes(String(x.releaseId))) : [];
        await writeJson('site-additions.json', keep);
        return json({ ok: true, remaining: keep.length });
      }
      return json({ additions: list });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET/POST /api/manage/todos  – the admin to-do list (import/todos.json)
// POST {action:'add', title, detail, owner} | {action:'update', id, done?, title?, detail?, owner?} | {action:'delete', id}
app.http('adminTodos', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/todos',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const list = await readJson('todos.json', []);
      if (request.method === 'GET') return json({ todos: list });
      const b = await request.json();
      const now = new Date().toISOString();
      if (b.action === 'add') {
        if (!String(b.title || '').trim()) return json({ ok: false, error: 'Give it a title.' }, 400);
        list.push({ id: crypto.randomBytes(4).toString('hex'), title: String(b.title).trim().slice(0, 300),
          detail: String(b.detail || '').trim().slice(0, 3000), owner: b.owner === 'Claude' ? 'Claude' : 'Michael',
          done: false, created: now, doneAt: null });
      } else if (b.action === 'update') {
        const t = list.find(x => x.id === b.id);
        if (!t) return json({ ok: false, error: 'Not found' }, 404);
        if ('done' in b) { t.done = !!b.done; t.doneAt = t.done ? now : null; }
        for (const k of ['title', 'detail', 'owner', 'answer']) if (k in b) t[k] = String(b[k] ?? '').slice(0, 3000);
      } else if (b.action === 'delete') {
        const i = list.findIndex(x => x.id === b.id);
        if (i >= 0) list.splice(i, 1);
      } else return json({ ok: false, error: 'Unknown action' }, 400);
      await writeJson('todos.json', list);
      return json({ ok: true, todos: list });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/manage/report-key (owner) -> makes a new key for the weekly report and returns it once
app.http('adminReportKey', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/report-key',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const key = crypto.randomBytes(24).toString('hex');
      await container().getBlockBlobClient('report-key.txt').upload(key, key.length, { blobHTTPHeaders: { blobContentType: 'text/plain' } });
      return json({ ok: true, key });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/manage/remembering  (owner) body: [{ month, day, name, year, age, bands:[...] }] -> replaces the list
app.http('manageRemembering', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'manage/remembering',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (request.method === 'GET') return json(await readJson('remembering.json', []));
      const b = await request.json();
      if (!Array.isArray(b)) return json({ ok: false, error: 'Send a list' }, 400);
      const clean = b.filter(r => r.name && r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= 31)
        .map(r => ({ month: +r.month, day: +r.day, name: String(r.name).slice(0, 100), year: +r.year || null, age: +r.age || null,
                     note: r.note ? String(r.note).slice(0, 300) : null, bands: (r.bands || []).map(String).slice(0, 8) }));
      await writeJson('remembering.json', clean);
      return json({ ok: true, count: clean.length });
    } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
  }
});
