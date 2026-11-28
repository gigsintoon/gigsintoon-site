// Moving off SQL, step 3: every admin save (and the few public writes) done on the storage master instead of SQL.
// Each function matches what the SQL version in functions/*.js does - same checks, same answer - so the admin
// pages and Claude's tools don't notice the difference. Used when the switch "write-target" is on "storage".
const crypto = require('crypto');
const M = require('./master');
const { json } = require('./db');

const MEDIA = () => {
  const account = ((process.env.STORAGE_CONNECTION_STRING || '').match(/AccountName=([^;]+)/) || [])[1] || 'gigsintoonmedia';
  return `https://${account}.blob.core.windows.net/media/`;
};
const urlPath = p => String(p).split('/').map(encodeURIComponent).join('/');
const cleanPath = p => { const s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''); return !s || s.includes('..') || s.length > 400 ? null : s; };
const failDetail = (context, err) => { context.error(err); return json({ ok: false, error: String(err.message || err) }, 500); };
const { same, d10, nowIso, dateIso, nextId, newRow, setReleaseDate, setGigDate } = M;
const bandByName = (t, name) => t.Bands.find(b => same(b.Name, name));
const RELEASE_TYPES = ['Album', 'Single', 'EP', 'Compilation', 'Live', 'Reissue', 'Other'];
const STATUSES = ['NotPosted', 'Drafted', 'Posted', 'DoNotPost'];

// ---------------------------------------------------------------- releases
// The import (bands -> releases -> images), as IMPORT_SQL in functions/admin.js
function importRows(t, rows, base) {
  const now = nowIso(), touched = new Set();
  for (const r of rows) {
    if (!r || !r.band || !r.title || !/^\d{4}-\d{2}-\d{2}/.test(r.date || '')) continue;
    if (r.type && !RELEASE_TYPES.includes(r.type)) throw new Error(`"${r.type}" isn't a release type (${RELEASE_TYPES.join(', ')})`);
    if (r.status && !STATUSES.includes(r.status)) throw new Error(`"${r.status}" isn't a status`);
    const date = String(r.date).slice(0, 10);
    let b = bandByName(t, r.band);
    if (!b) { b = newRow(t, 'Bands', { BandId: nextId(t.Bands, 'BandId'), Name: r.band, NeverPost: false, CreatedAt: now, UpdatedAt: now }); t.Bands.push(b); }
    let rel = t.Releases.find(x => x.BandId === b.BandId && same(x.Title, r.title) && d10(x.ReleaseDate) === date);
    const fields = { ArtistDisplay: r.artistDisplay ?? null, ReleaseType: r.type || 'Album', ChartPosition: r.chart ?? null, ChartNote: r.chartNote ?? null,
                     TagNotes: r.tagNotes ?? null, Status: r.status || 'NotPosted', OnSonosPlaylist: !!r.onSonos, ReleaseRegion: r.region ?? null };
    if (rel) {
      Object.assign(rel, fields, { Label: r.label ?? rel.Label, WriteUp: r.writeUp ?? rel.WriteUp, UpdatedAt: now });
    } else {
      rel = newRow(t, 'Releases', { ReleaseId: nextId(t.Releases, 'ReleaseId'), BandId: b.BandId, Title: r.title, ...fields, Label: r.label ?? null,
                                   WriteUp: r.writeUp ?? null, Owned: false, CreatedAt: now, UpdatedAt: now });
      setReleaseDate(rel, date);
      t.Releases.push(rel);
    }
    touched.add(rel.ReleaseId);
    for (const img of r.images || []) {
      if (!img.path) continue;
      const alt = `${img.kind} cover of ${rel.Title} by ${rel.ArtistDisplay != null ? rel.ArtistDisplay : r.band}`;
      const vals = { Kind: img.kind, PublicUrl: base + (img.urlPath || urlPath(img.path)), AltText: alt, SortOrder: img.order };
      const have = t.Images.find(i => i.ReleaseId === rel.ReleaseId && same(i.BlobPath, img.path));
      if (have) Object.assign(have, vals);
      else t.Images.push(newRow(t, 'Images', { ImageId: nextId(t.Images, 'ImageId'), ReleaseId: rel.ReleaseId, GigId: null, BlobPath: img.path, ...vals, CreatedAt: now }));
    }
  }
  // colours changed on the admin page win over the spreadsheet (music.StatusOverrides)
  let kept = 0;
  for (const o of t.StatusOverrides) {
    kept++;
    const b = bandByName(t, o.Band);
    if (!b) continue;
    t.Releases.filter(x => x.BandId === b.BandId && same(x.Title, o.Title) && d10(x.ReleaseDate) === d10(o.ReleaseDate))
      .forEach(x => { x.Status = o.Status; x.OnSonosPlaylist = !!o.OnSonos; x.UpdatedAt = now; });
  }
  return { RowsInFile: rows.length, ReleasesSaved: touched.size, ImagesLinked: t.Images.filter(i => touched.has(i.ReleaseId)).length,
           BandsTotal: t.Bands.length, ReleasesTotal: t.Releases.length, StatusOverridesKept: kept };
}
const IMPORT_TABLES = ['Bands', 'Releases', 'Images', 'StatusOverrides'];

async function importFile(rows) {
  return M.change(IMPORT_TABLES, t => importRows(t, rows, MEDIA()), 'import');
}

async function release(request, context) {
  try {
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    for (const r of rows) {
      if (!r.band || !r.title || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return json({ ok: false, error: 'Each release needs band, title and date (YYYY-MM-DD).' }, 400);
      r.type = r.type || 'Album'; r.status = r.status || 'NotPosted'; r.onSonos = !!r.onSonos;
      if (r.chart != null && r.chart !== '') { const n = parseInt(String(r.chart).replace(/[^0-9]/g, ''), 10); r.chart = Number.isFinite(n) && n > 0 ? n : null; } else r.chart = null;
      r.images = (r.images || []).map((img, i) => { const path = cleanPath(img.path); return { kind: img.kind || 'Cover', path, urlPath: path && urlPath(path), order: img.order || i + 1 }; });
    }
    const out = await M.change(IMPORT_TABLES, t => {
      const result = importRows(t, rows, MEDIA());
      const saved = [];
      for (const r of rows) {
        const b = bandByName(t, r.band);
        t.Releases.filter(x => b && x.BandId === b.BandId && same(x.Title, r.title) && d10(x.ReleaseDate) === r.date).forEach(x => saved.push({
          ReleaseId: x.ReleaseId, Band: b.Name, Title: x.Title, ReleaseDate: x.ReleaseDate, Status: x.Status,
          Images: t.Images.filter(i => i.ReleaseId === x.ReleaseId).sort((a, c) => a.SortOrder - c.SortOrder).map(i => ({ Kind: i.Kind, PublicUrl: i.PublicUrl })) }));
      }
      return { ...result, saved };
    }, 'release');
    return json({ ok: true, ...out });
  } catch (err) { return failDetail(context, err); }
}

async function releaseDelete(request, context) {
  try {
    const b = await request.json();
    if (!b.band || !b.title || !b.date) return json({ ok: false, error: 'Give band, title and date' }, 400);
    const out = await M.change(['Bands', 'Releases', 'Images', 'SocialPosts', 'ReleaseLinks', 'StatusOverrides'], t => {
      const band = bandByName(t, b.band);
      const found = t.Releases.filter(x => band && x.BandId === band.BandId && same(x.Title, b.title) && d10(x.ReleaseDate) === String(b.date).slice(0, 10))
        .map(x => ({ ReleaseId: x.ReleaseId, Name: band.Name, Title: x.Title, ReleaseDate: x.ReleaseDate }));
      if (found.length !== 1 || b.confirm !== true) return { confirm: false, found };
      const id = found[0].ReleaseId;
      for (const n of ['Images', 'SocialPosts', 'ReleaseLinks']) t[n] = t[n].filter(x => x.ReleaseId !== id);
      t.Releases = t.Releases.filter(x => x.ReleaseId !== id);
      return { confirm: true, deleted: found[0] };
    }, 'release-delete');
    return json({ ok: true, ...out });
  } catch (err) { return failDetail(context, err); }
}

async function releaseImages(request, context) {
  try {
    const body = await request.json();
    const rows = [];
    for (const r of (Array.isArray(body) ? body : [body])) (r.images || []).forEach((img, i) => {
      const path = cleanPath(img.path);
      if (path) rows.push({ band: r.band, title: r.title, date: String(r.date || '').slice(0, 10), kind: img.kind || 'Cover', path, url: MEDIA() + urlPath(path), order: img.order || i + 1 });
    });
    const out = await M.change(['Bands', 'Releases', 'Images'], t => {
      let linked = 0;
      for (const j of rows) {
        const b = bandByName(t, j.band);
        const rel = b && t.Releases.find(x => x.BandId === b.BandId && same(x.Title, j.title) && d10(x.ReleaseDate) === j.date);
        if (!rel) continue;
        linked++;
        const vals = { Kind: j.kind, PublicUrl: j.url, SortOrder: j.order, AltText: `${j.kind} cover of ${rel.Title} by ${rel.ArtistDisplay != null ? rel.ArtistDisplay : b.Name}` };
        const have = t.Images.find(i => i.ReleaseId === rel.ReleaseId && same(i.BlobPath, j.path));
        if (have) Object.assign(have, vals);
        else t.Images.push(newRow(t, 'Images', { ImageId: nextId(t.Images, 'ImageId'), ReleaseId: rel.ReleaseId, GigId: null, BlobPath: j.path, ...vals, CreatedAt: nowIso() }));
      }
      return { Sent: rows.length, Linked: linked };
    }, 'release-images');
    return json({ ok: true, ...out });
  } catch (err) { return failDetail(context, err); }
}

const COLOURS = { none: { status: 'NotPosted', sonos: false }, orange: { status: 'Drafted', sonos: false },
                  green: { status: 'Posted', sonos: true }, red: { status: 'DoNotPost', sonos: false } };
async function month(request, context) {
  const m = parseInt(request.query.get('m'), 10);
  if (!(m >= 1 && m <= 12)) return json({ error: 'Give ?m=1..12' }, 400);
  try {
    const t = await M.read(['Bands', 'Releases', 'Images', 'StatusOverrides']);
    const bands = new Map(t.Bands.map(b => [b.BandId, b])), imgs = new Map();
    t.Images.forEach(i => { if (i.ReleaseId != null) imgs.set(i.ReleaseId, (imgs.get(i.ReleaseId) || 0) + 1); });
    const changed = new Set(t.StatusOverrides.map(o => o.ReleaseId));
    const rows = t.Releases.filter(r => r.ReleaseMonth === m).map(r => ({
      ReleaseId: r.ReleaseId, ReleaseDay: r.ReleaseDay, ReleaseYear: r.ReleaseYear, Band: (bands.get(r.BandId) || {}).Name, Title: r.Title, ReleaseType: r.ReleaseType,
      ChartPosition: r.ChartPosition, ChartNote: r.ChartNote, TagNotes: r.TagNotes, Status: r.Status, OnSonos: r.OnSonosPlaylist,
      HasWriteUp: r.WriteUp == null || r.WriteUp === '' ? 0 : 1, ImageCount: imgs.get(r.ReleaseId) || 0, Changed: changed.has(r.ReleaseId) }))
      .sort((a, b) => a.ReleaseDay - b.ReleaseDay || a.ReleaseYear - b.ReleaseYear || M.coll.compare(a.Band || '', b.Band || ''));
    return json({ month: m, rows });
  } catch (err) { return failDetail(context, err); }
}

async function status(request, context) {
  try {
    const { id, colour } = await request.json();
    const c = COLOURS[colour];
    if (!c || !Number.isInteger(id)) return json({ ok: false, error: 'Give id and colour (none, orange, green, red).' }, 400);
    const out = await M.change(['Bands', 'Releases', 'StatusOverrides'], t => {
      const r = t.Releases.find(x => x.ReleaseId === id);
      if (!r) return null;
      const now = nowIso();
      Object.assign(r, { Status: c.status, OnSonosPlaylist: c.sonos, UpdatedAt: now });
      const band = (t.Bands.find(b => b.BandId === r.BandId) || {}).Name;
      const vals = { Band: band, Title: r.Title, ReleaseDate: r.ReleaseDate, Colour: colour, Status: c.status, OnSonos: c.sonos, ChangedAt: now };
      const o = t.StatusOverrides.find(x => x.ReleaseId === id);
      if (o) Object.assign(o, vals); else t.StatusOverrides.push(newRow(t, 'StatusOverrides', { ReleaseId: id, ...vals }));
      return true;
    }, 'status');
    if (!out) return json({ ok: false, error: 'Release not found.' }, 404);
    return json({ ok: true, id, colour, status: c.status });
  } catch (err) { return failDetail(context, err); }
}

// POST /api/manage/mark-sent {posts:[{date:'YYYY-MM-DD', text, images:[url]}]}
// The nightly run sends the posts Buffer actually published that day; any release (or gig) they match that is still
// "Not posted" turns orange (Drafted). Never touches green, red or already-orange rows. Matching: the post's image is
// one of the release's own images, or the post text contains the title and the band (name, handle or hashtag).
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = s => norm(s).replace(/ /g, '');
function findRelease(t, bands, md, text, flat, imgs) {
  const cands = t.Releases.filter(r => d10(r.ReleaseDate).slice(5) === md);
  return cands.find(r => t.Images.some(i => i.ReleaseId === r.ReleaseId && imgs.has(String(i.PublicUrl || '').split('?')[0].toLowerCase())))
    || cands.find(r => {
      const band = bands.get(r.BandId) || {};
      const title = norm(r.Title).replace(/ (reissue|deluxe|remaster(ed)?)$/, '');
      if (!title || !(' ' + text + ' ').includes(' ' + title + ' ')) return false;
      const keys = [band.Name, band.XHandle, band.InstagramHandle, band.BlueskyHandle, band.Hashtag].filter(Boolean).map(squash).filter(k => k.length >= 3);
      return keys.some(k => flat.includes(k));
    });
}
// For the nightly checks: the release each post is about and its covers on Michael's own storage (reads only).
async function matchCovers(posts) {
  const t = await M.read(['Bands', 'Releases', 'Images']);
  const bands = new Map(t.Bands.map(x => [x.BandId, x]));
  return posts.slice(0, 300).map(p => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { key: p.key, error: 'bad date' };
    const imgs = new Set((p.images || []).map(u => String(u).split('?')[0].toLowerCase()));
    const r = findRelease(t, bands, p.date.slice(5), norm(p.text), squash(p.text), imgs);
    if (!r) return { key: p.key, match: null };
    const covers = t.Images.filter(i => i.ReleaseId === r.ReleaseId && i.Kind !== 'Teaser').sort((a, b) => (a.SortOrder || 0) - (b.SortOrder || 0)).map(i => i.PublicUrl).filter(Boolean);
    return { key: p.key, match: { id: r.ReleaseId, band: (bands.get(r.BandId) || {}).Name, title: r.Title, type: r.ReleaseType }, covers };
  });
}
async function markSent(request, context) {
  try {
    const b = await request.json().catch(() => ({}));
    const posts = Array.isArray(b.posts) ? b.posts.slice(0, 200) : [];
    if (!posts.length) return json({ ok: false, error: 'Give posts: [{date, text, images}]' }, 400);
    const dry = request.query.get('dry') === '1';
    const out = await M.change(['Bands', 'Releases', 'Images', 'StatusOverrides', 'Gigs', 'GigBands'], t => {
      const bands = new Map(t.Bands.map(x => [x.BandId, x]));
      const marked = [], unmatched = [], gigsMarked = [];
      const now = nowIso();
      for (const p of posts) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) continue;
        const md = p.date.slice(5), text = norm(p.text), flat = squash(p.text);
        const imgs = new Set((p.images || []).map(u => String(u).split('?')[0].toLowerCase()));
        // gig memories
        const gy = /gig memory/i.test(p.text || '') && (String(p.text).match(/\b(19|20)\d{2}\b/) || [])[0];
        if (gy) {
          const g = t.Gigs.find(x => d10(x.GigDate) === gy + '-' + md);
          if (g) { if (g.Status !== 'Posted') { if (!dry) Object.assign(g, { Status: 'Posted', UpdatedAt: now }); gigsMarked.push(g.GigId); } continue; }
        }
        const hit = findRelease(t, bands, md, text, flat, imgs);
        if (!hit) { unmatched.push({ date: p.date, text: String(p.text || '').slice(0, 80) }); continue; }
        if (hit.Status !== 'NotPosted') continue;
        const band = (bands.get(hit.BandId) || {}).Name;
        marked.push({ id: hit.ReleaseId, band, title: hit.Title });
        if (dry) continue;
        Object.assign(hit, { Status: 'Drafted', UpdatedAt: now });
        const vals = { Band: band, Title: hit.Title, ReleaseDate: hit.ReleaseDate, Colour: 'orange', Status: 'Drafted', OnSonos: hit.OnSonosPlaylist, ChangedAt: now };
        const o = t.StatusOverrides.find(x => x.ReleaseId === hit.ReleaseId);
        if (o) Object.assign(o, vals); else t.StatusOverrides.push(newRow(t, 'StatusOverrides', { ReleaseId: hit.ReleaseId, ...vals }));
      }
      return { marked, gigsMarked, unmatched };
    }, 'mark-sent');
    return json({ ok: true, dry, ...out });
  } catch (err) { return failDetail(context, err); }
}

const overrideOut = r => ({ id: r.ReleaseId, band: r.Band, title: r.Title, date: d10(r.ReleaseDate), colour: r.Colour, status: r.Status, sonos: !!r.OnSonos, at: r.ChangedAt });
async function statusOverrides(request, context) {
  try {
    if (request.method === 'GET') return json({ overrides: (await M.read(['StatusOverrides'])).StatusOverrides.map(overrideOut) });
    const ids = (request.query.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
    const remaining = await M.change(['StatusOverrides'], t => {
      t.StatusOverrides = ids.length ? t.StatusOverrides.filter(o => !ids.includes(o.ReleaseId)) : [];
      return t.StatusOverrides.length;
    }, 'status-overrides');
    return json({ ok: true, remaining: remaining ?? (await M.read(['StatusOverrides'])).StatusOverrides.length });
  } catch (err) { return failDetail(context, err); }
}

async function charts(request, context) {
  try {
    const b = await request.json();
    const ups = (b.updates || []).filter(u => Number.isInteger(u.id) && Number.isInteger(u.pos) && u.pos >= 1 && u.pos <= 200);
    if (!ups.length) return json({ ok: false, error: 'Nothing to update' }, 400);
    const n = await M.change(['Releases'], t => {
      let k = 0;
      for (const u of ups) { const r = t.Releases.find(x => x.ReleaseId === u.id); if (r && (b.overwrite === true || r.ChartPosition == null)) { r.ChartPosition = u.pos; k++; } }
      return k;
    }, 'charts');
    return json({ ok: true, updated: n || 0 });
  } catch (err) { return failDetail(context, err); }
}

async function fixNames(request, context) {
  try {
    const b = await request.json();
    const titles = (b.titles || []).filter(x => Number.isInteger(x.id) && String(x.title || '').trim());
    const out = await M.change(['Bands', 'Releases', 'GigBands'], t => {
      let n = 0; const bands = []; const now = nowIso();
      for (const x of titles) { const r = t.Releases.find(y => y.ReleaseId === x.id); if (r) { r.Title = x.title; r.UpdatedAt = now; n++; } }
      for (const { from, to } of (b.bands || [])) {
        if (!from || !to) continue;
        const old = bandByName(t, from), nu = bandByName(t, to);
        if (!old) bands.push(`${from} → ${to}: not found`);
        else if (!nu || nu === old) { old.Name = to; old.UpdatedAt = now; bands.push(`${from} → ${to}: renamed`); }
        else {
          t.Releases.forEach(r => { if (r.BandId === old.BandId) r.BandId = nu.BandId; });
          t.GigBands.forEach(g => { if (g.BandId === old.BandId && !t.GigBands.some(x => x.GigId === g.GigId && x.BandId === nu.BandId)) g.BandId = nu.BandId; });
          t.GigBands = t.GigBands.filter(g => g.BandId !== old.BandId);
          t.Bands = t.Bands.filter(x => x.BandId !== old.BandId);
          bands.push(`${from} → ${to}: merged`);
        }
      }
      return { titles: n, bands };
    }, 'fix-names');
    return json({ ok: true, ...out });
  } catch (err) { return failDetail(context, err); }
}

async function releaseFix(request, context) {
  try {
    const b = await request.json();
    const done = await M.change(['Releases'], t => {
      const out = []; const now = nowIso();
      for (const f of (b.fixes || [])) {
        if (!Number.isInteger(f.id)) continue;
        if (!(f.type || f.date || 'region' in f || 'chart' in f || f.title || f.writeUp)) continue;
        if (f.type && !RELEASE_TYPES.includes(f.type)) throw new Error(`"${f.type}" isn't a release type`);
        const r = t.Releases.find(x => x.ReleaseId === f.id);
        if (!r) { out.push({ id: f.id, ok: false }); continue; }
        if (f.type) r.ReleaseType = f.type;
        if (f.date) setReleaseDate(r, String(f.date).slice(0, 10));
        if ('region' in f) r.ReleaseRegion = f.region || null;
        if ('chart' in f) r.ChartPosition = f.chart || null;
        if (f.title) r.Title = String(f.title).trim();
        if (f.writeUp) r.WriteUp = String(f.writeUp);
        r.UpdatedAt = now;
        out.push({ id: f.id, ok: true });
      }
      return out;
    }, 'release-fix');
    return json({ ok: true, done });
  } catch (err) { return failDetail(context, err); }
}

async function resetReleases(request, context) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== 'DELETE ALL RELEASES') return json({ ok: false, error: 'Send { "confirm": "DELETE ALL RELEASES" }' }, 400);
    const out = await M.change(['Bands', 'Releases', 'Images', 'SocialPosts', 'GigBands', 'ReleaseLinks'], t => {
      t.Images = t.Images.filter(i => i.ReleaseId == null); t.SocialPosts = t.SocialPosts.filter(s => s.ReleaseId == null);
      t.Releases = []; t.ReleaseLinks = [];
      const onBill = new Set(t.GigBands.map(g => g.BandId)); t.Bands = t.Bands.filter(b => onBill.has(b.BandId));
      return { Bands: t.Bands.length, Releases: 0, Images: t.Images.length };
    }, 'reset-releases');
    return json({ ok: true, ...out });
  } catch (err) { return failDetail(context, err); }
}

async function imagePathsInUse() { return new Set((await M.read(['Images'])).Images.map(i => i.BlobPath)); }

async function siteInfoCounts() {
  const { m } = await M.manifest();
  const t = await M.read(['Releases', 'Bands', 'Gigs', 'Images']);
  return { db: { kb: Math.round((m.tables || []).reduce((s, x) => s + (x.bytes || 0), 0) / 1024),
                 tables: (m.tables || []).map(x => ({ TableName: 'music.' + x.table, Rows: x.rows, KB: Math.round((x.bytes || 0) / 1024) })).sort((a, b) => b.KB - a.KB),
                 note: 'Stored as files in Azure Storage (sizes are compressed).' },
           counts: { Releases: t.Releases.length, Bands: t.Bands.length, Gigs: t.Gigs.length, ImageRows: t.Images.length, Charted: t.Releases.filter(r => r.ChartPosition != null).length } };
}

// ---------------------------------------------------------------- gigs
async function gig(request, context) {
  try {
    const b = await request.json();
    const bands = (b.bands || []).map(s => String(s).trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !bands.length) return json({ ok: false, error: 'Give date (YYYY-MM-DD) and bands' }, 400);
    const status = STATUSES.includes(b.status) ? b.status : 'Posted';
    const out = await M.change(['Bands', 'Venues', 'Gigs', 'GigBands', 'Images'], t => {
      const now = nowIso();
      let venueId = null;
      if (b.venue) {
        let v = t.Venues.find(x => same(x.Name, b.venue));
        if (!v) { v = newRow(t, 'Venues', { VenueId: nextId(t.Venues, 'VenueId'), Name: b.venue, City: b.city || null }); t.Venues.push(v); }
        venueId = v.VenueId;
      }
      for (const n of bands) if (!bandByName(t, n)) t.Bands.push(newRow(t, 'Bands', { BandId: nextId(t.Bands, 'BandId'), Name: n, NeverPost: false, CreatedAt: now, UpdatedAt: now }));
      let g = Number.isInteger(b.id) ? t.Gigs.find(x => x.GigId === b.id) : null;
      if (!g) {
        const head = bandByName(t, bands[0]);
        g = t.Gigs.find(x => d10(x.GigDate) === b.date && t.GigBands.some(gb => gb.GigId === x.GigId && gb.BillOrder === 1 && gb.BandId === head.BandId)) || null;
      }
      if (!g) {
        g = newRow(t, 'Gigs', { GigId: nextId(t.Gigs, 'GigId'), VenueId: venueId, VenueAsBilled: b.venueAsBilled || null, TourName: b.tour || null,
                               WriteUp: b.writeUp || null, Status: status, CreatedAt: now, UpdatedAt: now });
        setGigDate(g, b.date);
        t.Gigs.push(g);
      } else {
        setGigDate(g, b.date);
        Object.assign(g, { VenueId: venueId ?? g.VenueId, VenueAsBilled: b.venueAsBilled || g.VenueAsBilled, TourName: b.tour || g.TourName,
                           WriteUp: b.writeUp || g.WriteUp, Status: status, UpdatedAt: now });
      }
      t.GigBands = t.GigBands.filter(x => x.GigId !== g.GigId);
      bands.forEach((n, i) => { const x = bandByName(t, n); if (!t.GigBands.some(y => y.GigId === g.GigId && y.BandId === x.BandId))
        t.GigBands.push(newRow(t, 'GigBands', { GigId: g.GigId, BandId: x.BandId, Billing: i === 0 ? 'Headliner' : 'Support', BillOrder: i + 1 })); });
      if (b.images) {
        t.Images = t.Images.filter(i => i.GigId !== g.GigId);
        b.images.forEach((img, i) => t.Images.push(newRow(t, 'Images', { ImageId: nextId(t.Images, 'ImageId'), ReleaseId: null, GigId: g.GigId, Kind: img.kind || 'Ticket',
          BlobPath: img.path, PublicUrl: MEDIA() + urlPath(img.path), SortOrder: i + 1, Source: 'Own photo', CreatedAt: now })));
      }
      if (b.setlist) g.SetlistJson = JSON.stringify(b.setlist);
      if (b.setlistUrl) g.SetlistUrl = b.setlistUrl;
      if (b.playlistUrl) g.PlaylistUrl = b.playlistUrl;
      let videosSaved = null;
      if (Array.isArray(b.videos)) {
        const vids = b.videos.map(x => ({ id: String(x.id || '').replace(/[^\w-]/g, '').slice(0, 20), title: String(x.title || '').slice(0, 200) })).filter(x => x.id);
        g.VideoJson = JSON.stringify(vids); videosSaved = vids.length;
      }
      return { gigId: g.GigId, videosSaved };
    }, 'gig');
    return json({ ok: true, ...out });
  } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
}

async function gigImage(request, context) {
  try {
    const b = await request.json();
    const gigId = parseInt(b.gigId, 10);
    if (!gigId) return json({ ok: false, error: 'Give gigId' }, 400);
    if (b.remove) {
      await M.change(['Images'], t => { t.Images = t.Images.filter(i => !(i.GigId === gigId && i.PublicUrl === String(b.url || ''))); }, 'gig-image remove');
      return json({ ok: true });
    }
    const path = String(b.path || '').replace(/^\/+/, '');
    if (!path || path.includes('..')) return json({ ok: false, error: 'Give path' }, 400);
    const url = MEDIA() + urlPath(path);
    await M.change(['Images'], t => {
      const mine = t.Images.filter(i => i.GigId === gigId);
      t.Images.push(newRow(t, 'Images', { ImageId: nextId(t.Images, 'ImageId'), ReleaseId: null, GigId: gigId,
        Kind: ['Ticket', 'Photo', 'Setlist', 'Poster'].includes(b.kind) ? b.kind : 'Photo', BlobPath: path, PublicUrl: url,
        SortOrder: mine.reduce((mx, i) => Math.max(mx, i.SortOrder || 0), 0) + 1, Source: 'Own photo', CreatedAt: nowIso() }));
    }, 'gig-image');
    return json({ ok: true, url });
  } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
}

async function gigDelete(request, context) {
  try {
    const b = await request.json();
    const id = parseInt(b.id, 10);
    if (!id) return json({ ok: false, error: 'Give id' }, 400);
    const out = await M.change(['Gigs', 'GigBands', 'Bands', 'Images', 'SocialPosts'], t => {
      const g = t.Gigs.find(x => x.GigId === id);
      if (!g) return { missing: true };
      const names = t.GigBands.filter(x => x.GigId === id).map(x => (t.Bands.find(y => y.BandId === x.BandId) || {}).Name);
      const preview = { GigId: id, GigDate: g.GigDate, Bands: names.length ? names.join(', ') : null };
      if (b.confirm !== true) return { preview };
      t.Gigs = t.Gigs.filter(x => x.GigId !== id); t.GigBands = t.GigBands.filter(x => x.GigId !== id); t.Images = t.Images.filter(x => x.GigId !== id);
      t.SocialPosts.forEach(s => { if (s.GigId === id) s.GigId = null; });
      return { deleted: preview };
    }, 'gig-delete');
    if (out.missing) return json({ ok: false, error: 'No gig with that id' }, 404);
    return json({ ok: true, ...out });
  } catch (err) { context.error(err); return json({ ok: false, error: String(err.message || err) }, 500); }
}

// ---------------------------------------------------------------- links
async function releaseLinks(request, context) {
  try {
    const ok = u => (typeof u === 'string' && /^https:\/\/(music\.apple\.com|www\.deezer\.com)\//.test(u)) ? u.slice(0, 400) : null;
    const rows = (await request.json()).filter(x => Number.isInteger(x.id)).map(x => ({ id: x.id, apple: ok(x.apple), deezer: ok(x.deezer) }));
    const saved = await M.change(['Releases', 'ReleaseLinks'], t => setLinks(t, rows, false), 'release-links');
    return json({ ok: true, saved: saved || 0 });
  } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
}
// keepApple: deezer-fill only sets the Deezer link (keeping the Apple one, or using the one found)
function setLinks(t, rows, deezerOnly) {
  let n = 0; const now = nowIso();
  for (const x of rows) {
    const have = t.ReleaseLinks.find(l => l.ReleaseId === x.id);
    if (have) { if (deezerOnly) have.DeezerUrl = x.url; else { have.AppleUrl = x.apple; have.DeezerUrl = x.deezer; } have.UpdatedAt = now; n++; }
    else if (t.Releases.some(r => r.ReleaseId === x.id)) {
      t.ReleaseLinks.push(newRow(t, 'ReleaseLinks', { ReleaseId: x.id, AppleUrl: x.apple || null, DeezerUrl: deezerOnly ? x.url : x.deezer, UpdatedAt: now })); n++;
    }
  }
  t.ReleaseLinks.sort((a, b) => a.ReleaseId - b.ReleaseId);
  return n;
}
async function deezerCandidates(ids) {
  const t = await M.read(['Releases', 'Bands', 'ReleaseLinks']);
  return t.Releases.filter(r => ids.includes(r.ReleaseId)).map(r => {
    const l = t.ReleaseLinks.find(x => x.ReleaseId === r.ReleaseId) || {};
    return { ReleaseId: r.ReleaseId, Title: r.Title, ReleaseType: r.ReleaseType, Band: (t.Bands.find(b => b.BandId === r.BandId) || {}).Name, AppleUrl: l.AppleUrl || null, DeezerUrl: l.DeezerUrl || null };
  });
}
async function deezerSave(found) { return M.change(['Releases', 'ReleaseLinks'], t => setLinks(t, found, true), 'deezer-fill'); }

async function writeupReplace(request, context) {
  try {
    const b = await request.json();
    const find = String(b.find || '').trim(), rep = String(b.replace ?? '');
    if (find.length < 3) return json({ ok: false, error: 'Give find (3+ characters)' }, 400);
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'gi');
    const changes = await M.change(['Releases'], t => {
      const ch = t.Releases.filter(r => r.WriteUp && r.WriteUp.toLowerCase().includes(find.toLowerCase()))
        .map(r => ({ r, id: r.ReleaseId, after: r.WriteUp.replace(re, rep) })).filter(c => c.after !== c.r.WriteUp);
      if (b.confirm === true) { const now = nowIso(); ch.forEach(c => { c.r.WriteUp = c.after; c.r.UpdatedAt = now; }); }
      return ch.map(c => ({ id: c.id, after: c.after }));
    }, 'writeup-replace');
    return json({ ok: true, confirm: b.confirm === true, count: changes.length, changes: changes.map(c => ({ id: c.id, after: c.after.slice(0, 200) })) });
  } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
}

// ---------------------------------------------------------------- messages, to-dos, lists
const unreadOf = t => t.Messages.filter(m => !m.IsRead && m.DeletedAt == null).length;
async function setUnread(n) { await require('./store').put('meta', 'messages', 'unread', { N: n }); }
async function contactSave({ name, email, topic, message }) {
  const at = new Date();
  const id = at.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
  const n = await M.change(['Messages'], t => {
    t.Messages.push(newRow(t, 'Messages', { MessageId: id, ReceivedAt: nowIso(), Name: name || null, Email: email || null, Topic: topic, Body: message, IsRead: false, DeletedAt: null }));
    t.Messages.sort((a, b) => (a.MessageId < b.MessageId ? -1 : 1));
    return unreadOf(t);
  }, 'contact');
  await setUnread(n).catch(() => {});
}
const msgOut = m => ({ id: m.MessageId, at: m.ReceivedAt, name: m.Name, email: m.Email, topic: m.Topic, message: m.Body, read: !!m.IsRead, deletedAt: m.DeletedAt || undefined });
async function messages(request, context) {
  try {
    if (request.method === 'POST') {
      const b = await request.json();
      const id = String(b.id || '');
      const n = await M.change(['Messages'], t => {
        const m = t.Messages.find(x => x.MessageId === id);
        if (b.action === 'purge') t.Messages = t.Messages.filter(x => x.MessageId !== id);
        else if (m && b.action === 'delete') m.DeletedAt = nowIso();
        else if (m && b.action === 'restore') m.DeletedAt = null;
        else if (m && !b.action) m.IsRead = !!b.read;
        return unreadOf(t);
      }, 'messages');
      await setUnread(n).catch(() => {});
      return json({ ok: true });
    }
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const n = await M.change(['Messages'], t => { t.Messages = t.Messages.filter(m => !(m.DeletedAt && m.DeletedAt < cutoff)); return unreadOf(t); }, 'messages tidy');
    const all = (await M.read(['Messages'])).Messages.slice().sort((a, b) => (a.ReceivedAt < b.ReceivedAt ? 1 : a.ReceivedAt > b.ReceivedAt ? -1 : 0)).map(msgOut);
    await setUnread(n ?? all.filter(m => !m.read && !m.deletedAt).length).catch(() => {});
    return json({ messages: all.filter(m => !m.deletedAt), bin: all.filter(m => m.deletedAt) });
  } catch (err) { return failDetail(context, err); }
}

async function bandsList(request, context) {
  try { return json({ bands: (await M.read(['Bands'])).Bands.map(b => b.Name).sort((a, b) => M.coll.compare(a, b)) }); }
  catch (err) { return failDetail(context, err); }
}

async function siteAdditions(request, context) {
  try {
    if (request.method === 'POST') {
      const e = await request.json();
      const count = await M.change(['SiteAdditions'], t => {
        t.SiteAdditions.push(newRow(t, 'SiteAdditions', { AdditionId: nextId(t.SiteAdditions, 'AdditionId'), ReleaseId: Number.isInteger(e.releaseId) ? e.releaseId : null,
                                                           Entry: JSON.stringify(e), AddedAt: nowIso() }));
        return t.SiteAdditions.length;
      }, 'site-additions');
      return json({ ok: true, count });
    }
    if (request.method === 'DELETE') {
      const ids = (request.query.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
      const remaining = await M.change(['SiteAdditions'], t => { t.SiteAdditions = ids.length ? t.SiteAdditions.filter(a => !ids.includes(a.ReleaseId)) : []; return t.SiteAdditions.length; }, 'site-additions');
      return json({ ok: true, remaining: remaining ?? (await M.read(['SiteAdditions'])).SiteAdditions.length });
    }
    const rows = (await M.read(['SiteAdditions'])).SiteAdditions.slice().sort((a, b) => a.AdditionId - b.AdditionId);
    return json({ additions: rows.map(r => ({ ...JSON.parse(r.Entry), at: r.AddedAt })) });
  } catch (err) { return failDetail(context, err); }
}

const todoOut = t => ({ id: t.TodoId, title: t.Title, detail: t.Detail || '', owner: t.Owner, done: !!t.Done, answer: t.Answer || undefined, created: t.CreatedAt, doneAt: t.DoneAt });
const todoList = t => t.Todos.slice().sort((a, b) => (a.CreatedAt < b.CreatedAt ? -1 : a.CreatedAt > b.CreatedAt ? 1 : 0)).map(todoOut);
async function todos(request, context) {
  try {
    if (request.method === 'GET') return json({ todos: todoList(await M.read(['Todos'])) });
    const b = await request.json();
    if (!['add', 'update', 'delete'].includes(b.action)) return json({ ok: false, error: 'Unknown action' }, 400);
    if (b.action === 'add' && !String(b.title || '').trim()) return json({ ok: false, error: 'Give it a title.' }, 400);
    const res = await M.change(['Todos'], t => {
      if (b.action === 'add') {
        t.Todos.push(newRow(t, 'Todos', { TodoId: crypto.randomBytes(4).toString('hex'), Title: String(b.title).trim().slice(0, 300), Detail: String(b.detail || '').trim().slice(0, 3000),
                                          Owner: b.owner === 'Claude' ? 'Claude' : 'Michael', Done: false, CreatedAt: nowIso() }));
      } else if (b.action === 'update') {
        const x = t.Todos.find(y => y.TodoId === String(b.id || ''));
        const any = 'done' in b || ['title', 'detail', 'owner', 'answer'].some(k => k in b);
        if (!any) return { error: 'Nothing to change', status: 400 };
        if (!x) return { error: 'Not found', status: 404 };
        if ('done' in b) { x.Done = !!b.done; x.DoneAt = b.done ? nowIso() : null; }
        for (const [k, col, n] of [['title', 'Title', 300], ['detail', 'Detail', 3000], ['owner', 'Owner', 10], ['answer', 'Answer', 3000]]) if (k in b) x[col] = String(b[k] ?? '').slice(0, n);
      } else t.Todos = t.Todos.filter(y => y.TodoId !== String(b.id || ''));
      return { list: todoList(t) };
    }, 'todos');
    if (res && res.error) return json({ ok: false, error: res.error }, res.status);
    return json({ ok: true, todos: res ? res.list : todoList(await M.read(['Todos'])) });
  } catch (err) { return failDetail(context, err); }
}

async function reportKeySave(hash) {
  await M.change(['Settings'], t => {
    const s = t.Settings.find(x => x.Name === 'ReportKeyHash');
    if (s) { s.Value = hash; s.UpdatedAt = nowIso(); } else t.Settings.push(newRow(t, 'Settings', { Name: 'ReportKeyHash', Value: hash, UpdatedAt: nowIso() }));
  }, 'report-key');
  await require('./store').setCached('runner-keyhash', 'k', hash);
}
async function reportKeyHash() {
  const s = (await M.read(['Settings'])).Settings.find(x => x.Name === 'ReportKeyHash');
  return s ? s.Value : null;
}

async function remembering(request, context) {
  try {
    if (request.method === 'GET') {
      const rows = (await M.read(['Remembering'])).Remembering.slice().sort((a, b) => a.DeathMonth - b.DeathMonth || a.DeathDay - b.DeathDay);
      return json(rows.map(r => ({ month: r.DeathMonth, day: r.DeathDay, name: r.Name, year: r.DeathYear, age: r.Age, note: r.Note, bands: JSON.parse(r.Bands || '[]') })));
    }
    const b = await request.json();
    if (!Array.isArray(b)) return json({ ok: false, error: 'Send a list' }, 400);
    const clean = b.filter(r => r.name && r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= 31)
      .map(r => ({ month: +r.month, day: +r.day, name: String(r.name).slice(0, 100), year: +r.year || null, age: +r.age || null,
                   note: r.note ? String(r.note).slice(0, 300) : null, bands: JSON.stringify((r.bands || []).map(String).slice(0, 8)) }));
    await M.change(['Remembering'], t => {
      let id = nextId(t.Remembering, 'RememberId');
      t.Remembering = clean.map(r => newRow(t, 'Remembering', { RememberId: id++, DeathMonth: r.month, DeathDay: r.day, Name: r.name, DeathYear: r.year, Age: r.age, Note: r.note, Bands: r.bands }));
    }, 'remembering');
    return json({ ok: true, count: clean.length });
  } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
}

async function favourites(request, context) {
  try {
    const b = await request.json();
    const year = parseInt(b.year, 10);
    if (!(year >= 1950 && year <= 2100) || !Array.isArray(b.albums)) return json({ error: 'Need year and albums.' }, 400);
    const n = await M.change(['FavouriteYears', 'FavouriteAlbums'], t => {
      t.FavouriteAlbums = t.FavouriteAlbums.filter(a => a.Year !== year);
      t.FavouriteYears = t.FavouriteYears.filter(y => y.Year !== year);
      t.FavouriteYears.push(newRow(t, 'FavouriteYears', { Year: year, Title: String(b.title || `My favourite albums of ${year}`), Note: b.note || null, Kind: null, Ranked: !!b.ranked }));
      t.FavouriteYears.sort((a, c) => a.Year - c.Year);
      let id = nextId(t.FavouriteAlbums, 'FavouriteId'), i = 0;
      for (const a of b.albums) t.FavouriteAlbums.push(newRow(t, 'FavouriteAlbums', { FavouriteId: id++, Year: year, SortOrder: ++i, Rank: a.rank == null ? null : +a.rank,
        Artist: String(a.artist), Title: String(a.title), Note: a.note || null, CoverUrl: a.cover || null }));
      return i;
    }, 'favourites');
    return json({ ok: true, year, albums: n });
  } catch (err) { context.error(err); return json({ error: 'Something went wrong saving.' }, 500); }
}

// ---------------------------------------------------------------- guess the cover: the day's pick
const pickOrder = (id, period) => crypto.createHash('sha256').update(id + '|' + period).digest().readUInt32BE(0);
async function puzzle(period, { create = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return null;       // the old weekly puzzles aren't kept
  const fromRows = (t, id) => {
    const r = t.Releases.find(x => x.ReleaseId === id); if (!r) return null;
    const b = t.Bands.find(x => x.BandId === r.BandId) || {};
    const imgs = t.Images.filter(i => i.ReleaseId === id).sort((a, c) => a.SortOrder - c.SortOrder || a.ImageId - c.ImageId);
    return { ReleaseId: r.ReleaseId, ReleaseYear: r.ReleaseYear, ReleaseType: r.ReleaseType, Title: r.Title, Artist: r.ArtistDisplay != null ? r.ArtistDisplay : b.Name,
             BandId: b.BandId, ReleaseMonth: r.ReleaseMonth, ReleaseDay: r.ReleaseDay, CoverUrl: imgs.length ? imgs[0].PublicUrl : null };
  };
  const names = ['GuessPicks', 'Releases', 'Bands', 'Images'];
  const t0 = await M.read(names);
  const have = t0.GuessPicks.find(p => p.Period === period);
  if (have || !create) return have ? fromRows(t0, have.ReleaseId) : null;
  return M.change(['GuessPicks'], async t => {
    const again = t.GuessPicks.find(p => p.Period === period);
    if (again) return fromRows(t0, again.ReleaseId);
    const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const reached = r => (r.ReleaseMonth < +T.slice(5, 7) || (r.ReleaseMonth === +T.slice(5, 7) && r.ReleaseDay <= +T.slice(8, 10))) && d10(r.ReleaseDate) <= T;
    const visible = r => r.Status === 'Posted' || (r.Status === 'Drafted' && reached(r));
    const withImg = new Set(t0.Images.filter(i => i.ReleaseId != null).map(i => i.ReleaseId));
    const last = new Map(); t.GuessPicks.forEach(p => { const v = last.get(p.ReleaseId); if (!v || p.PickedAt > v) last.set(p.ReleaseId, p.PickedAt); });
    const cands = t0.Releases.filter(r => visible(r) && ['Album', 'EP', 'Single'].includes(r.ReleaseType) && withImg.has(r.ReleaseId))
      .sort((a, b) => (last.has(a.ReleaseId) ? 1 : 0) - (last.has(b.ReleaseId) ? 1 : 0) || String(last.get(a.ReleaseId) || '').localeCompare(String(last.get(b.ReleaseId) || ''))
        || pickOrder(a.ReleaseId, period) - pickOrder(b.ReleaseId, period) || a.ReleaseId - b.ReleaseId);
    if (!cands.length) return null;
    t.GuessPicks.push(newRow(t, 'GuessPicks', { Period: period, ReleaseId: cands[0].ReleaseId, PickedAt: new Date().toISOString() }));
    t.GuessPicks.sort((a, b) => (a.Period < b.Period ? -1 : 1));
    return fromRows(t0, cands[0].ReleaseId);
  }, 'guess pick');
}

// ---------------------------------------------------------------- weekly report bits
async function reportData() {
  const t = await M.read(['Messages', 'Todos', 'SiteAdditions', 'Releases', 'Gigs']);
  return {
    messages: t.Messages.filter(m => !m.IsRead && m.DeletedAt == null).sort((a, b) => (a.ReceivedAt < b.ReceivedAt ? -1 : 1))
      .map(m => ({ at: m.ReceivedAt, name: m.Name, topic: m.Topic, message: String(m.Body || '').slice(0, 600), hasEmail: !!m.Email })),
    todos: t.Todos.filter(x => !x.Done).sort((a, b) => (a.CreatedAt < b.CreatedAt ? -1 : 1)).map(x => ({ owner: x.Owner, title: x.Title, answer: x.Answer || '' })),
    additions: t.SiteAdditions.length,
    counts: { Releases: t.Releases.length, Gigs: t.Gigs.length }
  };
}

// Which days ("MM-DD") releases named by id are on (for refreshing those day pages)
async function daysOfReleases(ids) {
  const t = await M.read(['Releases']);
  return [...new Set(t.Releases.filter(r => ids.includes(r.ReleaseId)).map(r => String(r.ReleaseMonth).padStart(2, '0') + '-' + String(r.ReleaseDay).padStart(2, '0')))];
}

module.exports = { markSent, matchCovers, importFile, release, releaseDelete, releaseImages, month, status, statusOverrides, charts, fixNames, releaseFix, resetReleases,
                   imagePathsInUse, siteInfoCounts, gig, gigImage, gigDelete, releaseLinks, deezerCandidates, deezerSave, writeupReplace,
                   contactSave, messages, bandsList, siteAdditions, todos, reportKeySave, reportKeyHash, remembering, favourites, puzzle, reportData, daysOfReleases };
