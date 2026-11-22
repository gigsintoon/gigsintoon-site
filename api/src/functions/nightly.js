const { app } = require('@azure/functions');
const { query, json, fail, ukDay, runAsOwner } = require('../db');
const { isOwner, isRunner } = require('../auth');
const store = require('../store');

// The once-a-day database run (GitHub Action "Nightly run", using the report key). Its addresses are under
// /api/nightly/ because /api/manage/* only lets a signed-in owner in:
//   GET  /api/nightly/queue   -> the admin saves and contact messages waiting since yesterday
//   POST /api/nightly/run     {route, method, path, body} -> does one of them (or reads an admin list) as the owner
//   POST /api/nightly/queue   {done: name} -> clears a queued item once it's done
//   GET  /api/nightly/urls    -> saves the cover/ticket list for blurred teasers and returns every address with a
//                                ready-made answer, plus every band, gig and year page and the admin lists, to rebuild
// Michael can see what's waiting at GET /api/manage/queue.

app.http('manageQueue', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/queue',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try { const items = await store.queueList(); return json({ count: items.length, items }); }
    catch (err) { return fail(context, err); }
  }
});

app.http('nightlyQueue', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'nightly/queue',
  handler: async (request, context) => {
    if (!isRunner(request)) return json({ error: 'Only the overnight run.' }, 403);
    try {
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        return json({ ok: await store.queueDone(String(b.done || '')) });
      }
      const items = await store.queueList();
      return json({ count: items.length, items });
    } catch (err) { return fail(context, err); }
  }
});

app.http('nightlyRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'nightly/run',
  handler: async (request, context) => {
    if (!isRunner(request)) return json({ error: 'Only the overnight run.' }, 403);
    try {
      const b = await request.json().catch(() => ({}));
      const route = String(b.route || '');
      if (!/^(manage\/[\w-]+|contact)$/.test(route)) return json({ error: 'Not an admin route.' }, 400);
      const res = await runAsOwner(route, String(b.method || 'POST').toUpperCase(), String(b.path || '/api/' + route), b.body == null ? '' : String(b.body), context);
      const status = (res && res.status) || 200;
      return json({ status, body: res && res.jsonBody !== undefined ? res.jsonBody : null }, status >= 400 ? 502 : 200);
    } catch (err) { return fail(context, err); }
  }
});

app.http('nightlyUrls', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'nightly/urls',
  handler: async (request, context) => {
    if (!isRunner(request)) return json({ error: 'Only the overnight run.' }, 403);
    try {
      // GitHub sometimes starts the run late, so it's scheduled several times: only the first one each day does this
      if (request.query.get('force') !== '1' && await store.getStale('nightly-done').catch(() => null) === ukDay())
        return json({ skipped: true, urls: [] });
      const snap = await require('../catalogue').use(request);
      if (snap) {      // step 2: everything from the storage copy (doesn't wake the database)
        const fc = require('../fromcatalogue');
        const t = fc.teaserMap(snap), lists = fc.pageLists(snap);
        await store.setCached('teasermap', 'm', t.map);
        const urls = new Set(await store.cachedUrls());
        lists.bands.forEach(id => urls.add(`/api/bands/${id}`));
        lists.gigs.forEach(id => urls.add(`/api/gigs/${id}`));
        lists.years.forEach(y => urls.add(`/api/years/${y}`));
        for (let m = 1; m <= 12; m++) urls.add(`/api/manage/month?m=${m}`);
        ['todos', 'messages', 'bands', 'site-info', 'remembering', 'site-additions', 'status-overrides'].forEach(a => urls.add(`/api/manage/${a}`));
        await store.setCached('nightly-done', 'd', ukDay()).catch(() => {});
        return json({ teasers: t.count, source: 'catalogue', urls: [...urls].filter(u => u && u.startsWith('/api/')) });
      }
      // Addresses of covers and gig tickets, for the blurred teasers (so they never need the database in the day)
      const imgs = await query(`
        SELECT 'r' AS K, x.ReleaseId AS Id, x.PublicUrl FROM (
          SELECT i.ReleaseId, i.PublicUrl, ROW_NUMBER() OVER (PARTITION BY i.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS n
            FROM music.Images i JOIN music.Releases r ON r.ReleaseId = i.ReleaseId
           WHERE r.Status <> 'DoNotPost') x WHERE x.n = 1
        UNION ALL
        SELECT 'g', x.GigId, x.PublicUrl FROM (
          SELECT i.GigId, i.PublicUrl, ROW_NUMBER() OVER (PARTITION BY i.GigId ORDER BY i.SortOrder, i.ImageId) AS n
            FROM music.Images i JOIN music.Gigs g ON g.GigId = i.GigId
           WHERE g.Status = 'Posted') x WHERE x.n = 1`);
      const map = { r: {}, g: {} };
      imgs.forEach(x => { map[x.K][x.Id] = x.PublicUrl; });
      await store.setCached('teasermap', 'm', map);
      // Every page a visitor could ask for that isn't one of the 366 days
      const bands = await query(`SELECT DISTINCT r.BandId FROM music.Releases r WHERE r.Status IN ('Posted', 'Drafted')`);
      const gigs = await query(`SELECT GigId FROM music.Gigs WHERE Status = 'Posted'`);
      const years = await query(`SELECT DISTINCT ReleaseYear AS Y FROM music.Releases WHERE Status IN ('Posted', 'Drafted')`);
      const urls = new Set(await store.cachedUrls());
      bands.forEach(b => urls.add(`/api/bands/${b.BandId}`));
      gigs.forEach(g => urls.add(`/api/gigs/${g.GigId}`));
      years.forEach(y => urls.add(`/api/years/${y.Y}`));
      // Michael's admin lists, as they'll be shown to him tomorrow
      for (let m = 1; m <= 12; m++) urls.add(`/api/manage/month?m=${m}`);
      ['todos', 'messages', 'bands', 'site-info', 'remembering', 'site-additions', 'status-overrides'].forEach(a => urls.add(`/api/manage/${a}`));
      await store.setCached('nightly-done', 'd', ukDay()).catch(() => {});
      return json({ teasers: imgs.length, urls: [...urls].filter(u => u && u.startsWith('/api/')) });
    } catch (err) { return fail(context, err); }
  }
});
