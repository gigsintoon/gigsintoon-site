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
        m.read = !!b.read;
        await writeJson(name, m);
        return json({ ok: true });
      }
      const out = [];
      for await (const blob of container().listBlobsFlat({ prefix: 'contact/' })) {
        out.push(await readJson(blob.name, null));
      }
      out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
      return json({ messages: out.filter(Boolean) });
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
