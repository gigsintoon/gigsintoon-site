const { app } = require('@azure/functions');
const {
  sql, query, json, fail, store, handlesFor, norm, isOwner, isRunner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive, cat, fc, M, S, DAY_OK, GIG_COLS, VENUE_NORM, blurred, loadFavourites, clearFavourites, handleMap, UK_TODAY, DAY_REACHED, VISIBLE, RELEASE_COLUMNS, tidy, teaserUrl, ukDay, rememberingFor, weekCache
} = require('../shared-releases');

// GET /api/me -> is the visitor an admin?
app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: async (request) => json({ owner: isOwner(request) })
});

// GET /api/onthisday?month=11&day=21
app.http('onThisDay', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'onthisday',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const month = parseInt(request.query.get('month'), 10);
    const day = parseInt(request.query.get('day'), 10);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
      return json({ error: 'Please give a valid month and day.' }, 400);
    }
    const all = seesAll(request);
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.onThisDay(snap, month, day, all));
      const releases = tidy(await query(
        `SELECT ${RELEASE_COLUMNS}
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d ${all ? '' : `AND ${VISIBLE}`}
          ORDER BY r.ReleaseYear DESC, Artist`,
        { m: [sql.Int, month], d: [sql.Int, day] }), all);
      const gigs = await query(
        `SELECT g.GigId, YEAR(g.GigDate) AS GigYear, g.GigDate, g.TourName, g.WriteUp, g.Status,
                COALESCE(g.VenueAsBilled, v.Name) AS Venue,
                (SELECT STRING_AGG(b.Name, ' / ') WITHIN GROUP (ORDER BY gb.BillOrder)
                   FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId
                  WHERE gb.GigId = g.GigId) AS Bands,
                (SELECT TOP 1 i.PublicUrl FROM music.Images i
                  WHERE i.GigId = g.GigId ORDER BY i.SortOrder, i.ImageId) AS ImageUrl,
                (SELECT COUNT(*) FROM music.Images i WHERE i.GigId = g.GigId) AS ImageCount, g.PlaylistUrl
           FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE g.GigMonth = @m AND g.GigDay = @d ${all ? '' : `AND g.Status = 'Posted'`}
          ORDER BY g.GigDate DESC`,
        { m: [sql.Int, month], d: [sql.Int, day] });
      // A gig memory whose day hasn't come round yet this year: visitors get a blurred ticket and a clue instead
      let gigTeasers = [];
      if (!all) {
        const t = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()));
        const reached = month < t.getUTCMonth() + 1 || (month === t.getUTCMonth() + 1 && day <= t.getUTCDate());
        if (!reached) {
          gigTeasers = gigs.map(g => ({ Id: g.GigId, GigYear: g.GigYear, Letter: (g.Bands || '?').replace(/^the\s+/i, '').charAt(0).toUpperCase(),
                                        Acts: (g.Bands || '').split(' / ').length, HasImage: !!g.ImageUrl }));
          gigs.length = 0;
        }
      }
      // Visitors looking at a day that hasn't come round yet get clues instead: the year, the type,
      // the band's first letter and a blurred cover (served through /api/teaser so the file name gives nothing away).
      const teasers = all ? [] : await query(
        `SELECT r.ReleaseId AS Id, r.ReleaseYear, r.ReleaseType, UPPER(LEFT(COALESCE(r.ArtistDisplay, b.Name), 1)) AS Letter,
                CASE WHEN EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId) THEN 1 ELSE 0 END AS HasCover
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d AND NOT ${VISIBLE}
            AND r.Status <> 'DoNotPost' AND ISNULL(b.NeverPost, 0) = 0 AND NOT ${DAY_REACHED}
          ORDER BY r.ReleaseYear DESC`,
        { m: [sql.Int, month], d: [sql.Int, day] });
      const handles = handlesFor(await handleMap(), [...releases, ...gigs].map(x => x.WriteUp));
      const remembering = await rememberingFor(month, day);

      return json({ month, day, releases, gigs, teasers, gigTeasers, remembering, handles, admin: all });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/search?q=travis  -> matching bands (with release counts)
app.http('searchBands', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'search',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const q = (request.query.get('q') || '').trim();
    const all = seesAll(request);
    if (request.query.get('all') === '1') {   // every band a visitor can see, for searching in the browser
      try {
        const snap = await cat.use(request);
        if (snap) return json(fc.searchAll(snap));
        return json({ bands: await query(`SELECT b.BandId, b.Name, COUNT(*) AS ReleaseCount FROM music.Bands b
          JOIN music.Releases r ON r.BandId = b.BandId WHERE ${VISIBLE} GROUP BY b.BandId, b.Name ORDER BY b.Name`) });
      } catch (err) { return fail(context, err); }
    }
    if (q.length < 2) return json({ bands: [] });
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.search(snap, q, all));
      const bands = await query(
        `SELECT TOP 50 * FROM (
           SELECT b.BandId, b.Name,
                  (SELECT COUNT(*) FROM music.Releases r WHERE r.BandId = b.BandId ${all ? '' : `AND ${VISIBLE}`}) AS ReleaseCount
             FROM music.Bands b
            WHERE b.Name LIKE @q) x
          WHERE x.ReleaseCount > 0
          ORDER BY CASE WHEN x.Name LIKE @starts THEN 0 ELSE 1 END, x.Name`,
        { q: [sql.NVarChar, `%${q}%`], starts: [sql.NVarChar, `${q}%`] });
      return json({ bands });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/bands/12 -> band details and all their releases
app.http('band', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'bands/{id:int}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const id = parseInt(request.params.id, 10);
    const all = seesAll(request);
    try {
      const snap = await cat.use(request);
      if (snap) { const out = fc.band(snap, id, all); return out ? json(out) : json({ error: 'Band not found.' }, 404); }
      const bands = await query(
        `SELECT BandId, Name, XHandle, InstagramHandle, BlueskyHandle, Hashtag, NeverPost
           FROM music.Bands WHERE BandId = @id`, { id: [sql.Int, id] });
      if (!bands.length) return json({ error: 'Band not found.' }, 404);
      const releases = tidy(await query(
        `SELECT ${RELEASE_COLUMNS}
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.BandId = @id ${all ? '' : `AND ${VISIBLE}`}
          ORDER BY r.ReleaseDate DESC`, { id: [sql.Int, id] }), all);
      const map = await handleMap();
      const band = bands[0];
      if (!all) delete band.NeverPost;
      if (!band.XHandle) {
        const own = Object.entries(map).find(([, v]) => v.id === band.BandId);
        if (own) band.XHandle = '@' + own[0];
      }
      const gigs = await query(
        `SELECT ${GIG_COLS} FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE EXISTS (SELECT 1 FROM music.GigBands gb WHERE gb.GigId = g.GigId AND gb.BandId = @id)
            ${all ? '' : `AND g.Status = 'Posted' AND ${DAY_OK('g.GigMonth', 'g.GigDay')}`}
          ORDER BY g.GigDate DESC`, { id: [sql.Int, id] });
      return json({ band, releases, gigs, handles: handlesFor(map, releases.map(x => x.WriteUp)), admin: all });
    } catch (err) {
      return fail(context, err);
    }
  }
});

let favCache = null, favCacheAt = 0;
app.http('favourites', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'favourites',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.favourites(snap, isOwner(request)));
      if (!favCache || Date.now() - favCacheAt > 10 * 60 * 1000) {
        const rows = await query(
          `SELECT b.BandId, b.Name, r.Title, r.ReleaseYear,
                  (SELECT TOP 1 i.PublicUrl FROM music.Images i
                    WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl
             FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId`);
        const byBand = new Map();
        for (const r of rows) {
          const k = norm(r.Name);
          if (!byBand.has(k)) byBand.set(k, []);
          byBand.get(k).push(r);
        }
        const bandIds = new Map(rows.map(r => [norm(r.Name), r.BandId]));
        favCache = (await loadFavourites()).years.map(y => ({
          ...y,
          albums: (y.albums || []).map(a => {
            const cands = byBand.get(norm(a.artist)) || [];
            const t = norm(a.title);
            const hit = cands.find(c => norm(c.Title) === t) ||
                        cands.find(c => t.length > 3 && (norm(c.Title).startsWith(t) || t.startsWith(norm(c.Title))));
            return { ...a, bandId: bandIds.get(norm(a.artist)) || null,
                     cover: a.cover || (hit && hit.CoverUrl) || null };
          })
        }));
        favCacheAt = Date.now();
      }
      const upcoming = tidy(await query(
        `SELECT ${RELEASE_COLUMNS}
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseDate > ${UK_TODAY}
            AND r.Status <> 'DoNotPost'
          ORDER BY r.ReleaseDate`), isOwner(request));
      // upcoming write-ups are usually still drafts, so visitors only get the basics
      if (!isOwner(request)) upcoming.forEach(r => { r.WriteUp = null; });
      return json({ years: favCache, upcoming });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/teaser/123 -> the cover of a release that's still to come, without its file name (shown blurred)
app.http('teaser', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'teaser/{id:int}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const url = await teaserUrl('r', parseInt(request.params.id, 10),
        `SELECT TOP 1 i.PublicUrl FROM music.Images i JOIN music.Releases r ON r.ReleaseId = i.ReleaseId
          WHERE r.ReleaseId = @id AND r.Status <> 'DoNotPost' ORDER BY i.SortOrder, i.ImageId`, request);
      if (!url) return { status: 404 };
      const rows = [{ PublicUrl: url }];
      const b = Math.max(0, Math.min(40, parseFloat(request.query.get('b') ?? '12') || 0));
      const body = await blurred(rows[0].PublicUrl, isOwner(request) && request.query.get('b') === '0' ? 0 : Math.max(b, 1.5), Math.min(600, Math.max(96, parseInt(request.query.get('s') || '600', 10) || 600)));
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } };
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/gigteaser/5 -> a gig's ticket photo without its file name (shown blurred)
app.http('gigTeaser', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'gigteaser/{id:int}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const url = await teaserUrl('g', parseInt(request.params.id, 10),
        `SELECT TOP 1 i.PublicUrl FROM music.Images i JOIN music.Gigs g ON g.GigId = i.GigId
          WHERE g.GigId = @id AND g.Status = 'Posted' ORDER BY i.SortOrder, i.ImageId`, request);
      if (!url) return { status: 404 };
      const rows = [{ PublicUrl: url }];
      const b = Math.max(0, Math.min(40, parseFloat(request.query.get('b') ?? '12') || 0));
      const body = await blurred(rows[0].PublicUrl, isOwner(request) && request.query.get('b') === '0' ? 0 : Math.max(b, 1.5));
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } };
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/launch -> when the site goes live (used by the countdown page)
app.http('launch', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'launch',
  handler: async (request) => json({ launchAt: LAUNCH_AT, live: isLive(), now: new Date().toISOString(), owner: isOwner(request) })
});

// GET /api/random -> a random release a visitor can see (for "Surprise me")
app.http('randomRelease', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'random',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      // The list of candidates is kept ready-made for the day, so "Surprise me" doesn't wake the database.
      const stamp = (await store.dataVersion()) + '|' + ukDay();
      let pool = await store.getCached('randompool', stamp);
      // yesterday's list is fine for a random pick; only the overnight run rebuilds it
      if (!pool && !isRunner(request)) pool = await store.getStale('randompool');
      if (!pool) {
        try {
          const snap = await cat.use(request);
          if (snap) pool = fc.randomPool(snap);
          else pool = (await query(`SELECT r.ReleaseId, r.ReleaseMonth AS Month, r.ReleaseDay AS Day
               FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
              WHERE ${VISIBLE} AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)`)).map(r => [r.ReleaseId, r.Month, r.Day]);
          await store.setCached('randompool', stamp, pool).catch(() => {});
        } catch (err) {
          pool = await store.getStale('randompool');   // database unavailable: yesterday's list is fine
          if (!pool) throw err;
        }
      }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return json(pick ? { ReleaseId: pick[0], Month: pick[1], Day: pick[2] } : {}, 200);
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/years -> years with how many releases and gigs;  GET /api/years/1997 -> everything from that year
app.http('years', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'years/{year:int?}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const all = seesAll(request);
    try {
      const year = parseInt(request.params.year, 10);
      const snap = await cat.use(request);
      if (snap) return json(year ? fc.year(snap, year, all) : fc.yearsList(snap, all));
      if (!year) {
        const years = await query(
          `SELECT y, SUM(rel) AS Releases, SUM(gig) AS Gigs FROM (
             SELECT r.ReleaseYear AS y, 1 AS rel, 0 AS gig FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId ${all ? '' : `WHERE ${VISIBLE}`}
             UNION ALL SELECT YEAR(g.GigDate), 0, 1 FROM music.Gigs g ${all ? '' : `WHERE g.Status = 'Posted'`}) x
           GROUP BY y ORDER BY y DESC`);
        return json({ years: years.map(r => ({ year: r.y, releases: r.Releases, gigs: r.Gigs })) });
      }
      const releases = tidy(await query(
        `SELECT ${RELEASE_COLUMNS} FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseYear = @y ${all ? '' : `AND ${VISIBLE}`} ORDER BY r.ReleaseDate, Artist`,
        { y: [sql.Int, year] }), all);
      const gigs = await query(
        `SELECT g.GigId, YEAR(g.GigDate) AS GigYear, g.GigDate, g.TourName, COALESCE(g.VenueAsBilled, v.Name) AS Venue,
                (SELECT STRING_AGG(b.Name, ' / ') WITHIN GROUP (ORDER BY gb.BillOrder) FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId WHERE gb.GigId = g.GigId) AS Bands,
                (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.GigId = g.GigId ORDER BY i.SortOrder, i.ImageId) AS ImageUrl
           FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE YEAR(g.GigDate) = @y ${all ? '' : `AND g.Status = 'Posted'`} ORDER BY g.GigDate`,
        { y: [sql.Int, year] });
      const fav = ((await loadFavourites()).years || []).find(f => f.year === year);
      const handles = handlesFor(await handleMap(), releases.map(x => x.WriteUp));
      return json({ year, releases, gigs, favourites: fav && fav.albums ? fav.albums.map(a => norm(a.artist) + '|' + norm(a.title)) : [], handles });
    } catch (err) { return fail(context, err); }
  }
});

let statsCache = null, statsAt = 0;
app.http('stats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'stats',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.stats(snap));
      if (statsCache && Date.now() - statsAt < 30 * 60 * 1000) return json(statsCache);
      const V = `FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE ${VISIBLE}`;
      const [tot] = await query(`SELECT COUNT(*) AS Releases, COUNT(DISTINCT r.BandId) AS Bands, MIN(r.ReleaseYear) AS FirstYear ${V}`);
      const [gt] = await query(`SELECT COUNT(*) AS Gigs, COUNT(DISTINCT LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(COALESCE(v.Name, g.VenueAsBilled), ' Students'' Union', ''), ' Students’ Union', ''), ' Newcastle', '')))) AS Venues
        FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId WHERE g.Status = 'Posted'`);
      const topBands = await query(`SELECT TOP 15 b.BandId, b.Name, COUNT(*) AS N ${V} GROUP BY b.BandId, b.Name ORDER BY N DESC, b.Name`);
      const decades = await query(`SELECT (r.ReleaseYear / 10) * 10 AS Decade, COUNT(*) AS N ${V} GROUP BY (r.ReleaseYear / 10) * 10 ORDER BY Decade`);
      const types = await query(`SELECT r.ReleaseType AS Type, COUNT(*) AS N ${V} GROUP BY r.ReleaseType ORDER BY N DESC`);
      const topYears = await query(`SELECT TOP 10 r.ReleaseYear AS Year, COUNT(*) AS N ${V} GROUP BY r.ReleaseYear ORDER BY N DESC`);
      const gigYears = await query(`SELECT YEAR(GigDate) AS Year, COUNT(*) AS N FROM music.Gigs WHERE Status = 'Posted' GROUP BY YEAR(GigDate) ORDER BY Year`);
      // "Newcastle University Students' Union" and "Newcastle University" are the same place
      const VN = `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(COALESCE(v.Name, g.VenueAsBilled), ' Students'' Union', ''), ' Students’ Union', ''), ' Newcastle', '')))`;
      const venues = await query(`SELECT TOP 10 ${VN} AS Venue, COUNT(*) AS N FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
                                   WHERE g.Status = 'Posted' AND COALESCE(v.Name, g.VenueAsBilled) IS NOT NULL GROUP BY ${VN} ORDER BY N DESC`);
      const gigBands = await query(`SELECT TOP 10 b.BandId, b.Name, COUNT(*) AS N FROM music.GigBands gb JOIN music.Gigs g ON g.GigId = gb.GigId JOIN music.Bands b ON b.BandId = gb.BandId
                                     WHERE g.Status = 'Posted' GROUP BY b.BandId, b.Name HAVING COUNT(*) > 1 ORDER BY N DESC, b.Name`);
      const charts = await query(`SELECT COUNT(*) AS Charted, SUM(CASE WHEN r.ChartPosition <= 10 THEN 1 ELSE 0 END) AS Top10, SUM(CASE WHEN r.ChartPosition = 1 THEN 1 ELSE 0 END) AS No1 ${V} AND r.ChartPosition IS NOT NULL`);
      statsCache = { totals: { ...tot, ...gt, ...charts[0] }, topBands, decades, types, topYears, gigYears, venues, gigBands };
      statsAt = Date.now();
      return json(statsCache);
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/sitemap -> sitemap.xml for search engines (rewritten from /sitemap.xml)
app.http('sitemap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'sitemap',
  handler: async (request, context) => {
    try {
      const base = 'https://www.gigsintoon.co.uk';
      const snap = await cat.use(request);
      const urls = snap ? fc.sitemapUrls(snap) : ['/', '/about', '/contact', '/?page=favourites', '/?page=week', '/?page=stats', '/?page=guess'];
      if (!snap) {
      for (let m = 1; m <= 12; m++) for (let d = 1; d <= new Date(Date.UTC(2024, m, 0)).getUTCDate(); d++)
        urls.push(`/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      const bands = await query(`SELECT DISTINCT r.BandId FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE ${VISIBLE}`);
      bands.forEach(b => urls.push(`/?band=${b.BandId}`));
      const gigs = await query(`SELECT GigId FROM music.Gigs WHERE Status = 'Posted'`);
      gigs.forEach(g => urls.push(`/?gig=${g.GigId}`));
      const years = await query(`SELECT DISTINCT r.ReleaseYear AS Y FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE ${VISIBLE}`);
      years.forEach(y => urls.push(`/?year=${y.Y}`));
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url><loc>${base}${u.replace(/&/g, '&amp;')}</loc></url>`).join('\n') + '\n</urlset>\n';
      return { status: 200, body: xml, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/venue?name=Carling%20Academy -> every gig at that venue (names like "... Students' Union" are merged)
app.http('venue', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'venue',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const all = seesAll(request);
    const name = String(request.query.get('name') || '').trim().slice(0, 200);
    if (!name) return json({ error: 'Which venue?' }, 400);
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.venue(snap, name, all));
      const gigs = await query(
        `SELECT ${GIG_COLS}, v.City FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE ${VENUE_NORM} = LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(@n, ' Students'' Union', ''), ' Students’ Union', ''), ' Newcastle', '')))
            ${all ? '' : `AND g.Status = 'Posted' AND ${DAY_OK('g.GigMonth', 'g.GigDay')}`}
          ORDER BY g.GigDate`, { n: [sql.NVarChar(200), name] });
      return json({ venue: name.replace(/ Students['’] Union| Newcastle/g, '').trim(), city: gigs[0]?.City || null, gigs });
    } catch (err) { return fail(context, err); }
  }
});

app.http('week', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'week',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const all = seesAll(request);
    const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()));
    const key = (all ? 'a' : 'v') + today.toISOString().slice(0, 10);
    const hit = weekCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000 && !cat.isForced(request)) return json(hit.data);
    try {
      const snap = await cat.use(request);
      if (snap) return json(fc.week(snap, all));
      const days = [...Array(7)].map((_, i) => { const d = new Date(today.getTime() + i * 86400000); return { m: d.getUTCMonth() + 1, d: d.getUTCDate() }; });
      const D = [sql.NVarChar(sql.MAX), JSON.stringify(days)];
      const rel = await query(
        `SELECT r.ReleaseId, r.ReleaseMonth AS M, r.ReleaseDay AS D, r.ReleaseYear AS Y, COALESCE(r.ArtistDisplay, b.Name) AS Artist, r.Title,
                CASE WHEN ${all ? '1 = 1' : VISIBLE} THEN 1 ELSE 0 END AS Shown,
                CASE WHEN NOT ${VISIBLE} AND r.Status <> 'DoNotPost' AND ISNULL(b.NeverPost, 0) = 0 AND NOT ${DAY_REACHED} THEN 1 ELSE 0 END AS Teaser,
                (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS Cover
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
           JOIN OPENJSON(@days) WITH (m INT '$.m', d INT '$.d') x ON x.m = r.ReleaseMonth AND x.d = r.ReleaseDay
          ORDER BY r.ReleaseYear DESC`, { days: D });
      const gigs = await query(
        `SELECT g.GigMonth AS M, g.GigDay AS D, COUNT(*) AS N FROM music.Gigs g
           JOIN OPENJSON(@days) WITH (m INT '$.m', d INT '$.d') x ON x.m = g.GigMonth AND x.d = g.GigDay
          WHERE ${all ? '1 = 1' : `g.Status = 'Posted'`} GROUP BY g.GigMonth, g.GigDay`, { days: D });
      const thumb = u => '/api/thumb?s=128&u=' + encodeURIComponent(u);
      const data = { days: days.map(({ m, d }) => {
        const rs = rel.filter(r => r.M === m && r.D === d);
        const shown = all ? rs : rs.filter(r => r.Shown), teasers = all ? [] : rs.filter(r => !r.Shown && r.Teaser);
        const thumbs = [...shown.filter(r => r.Cover).map(r => ({ u: thumb(r.Cover), t: `${r.Y} · ${r.Artist} – ${r.Title}` })),
                        ...teasers.filter(r => r.Cover).map(r => ({ u: `/api/teaser/${r.ReleaseId}?b=14&s=128`, t: 'Mystery release', tz: true }))].slice(0, 12);
        const g = gigs.find(x => x.M === m && x.D === d);
        return { month: m, day: d, releases: shown.length + teasers.length, gigs: g ? g.N : 0, thumbs };
      }) };
      weekCache.set(key, { at: Date.now(), data });
      return json(data);
    } catch (err) { return fail(context, err); }
  }
});

// POST /api/manage/rebuild {month, day} | {favourites:true} | {all:true} (owner) -> refresh the ready-made pages
// (any admin save already does this; use it after changes made outside the admin pages, e.g. direct SQL or blob uploads)
app.http('rebuild', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/rebuild',
  handler: async (request) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    // The save wrapper does the work: {month, day} refreshes that day + the list pages, anything else refreshes everything
    return json({ ok: true });
  }
});

// POST /api/manage/favourites (owner) {year, title, note, ranked, albums:[{artist, title, note, cover, rank}]} -> replaces that year's list
app.http('adminFavourites', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/favourites',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    if (await M.on()) return S.favourites(request, context).then(r => { clearFavourites(); return r; });   // step 3: saved in storage
    try {
      const b = await request.json();
      const year = parseInt(b.year, 10);
      if (!(year >= 1950 && year <= 2100) || !Array.isArray(b.albums)) return json({ error: 'Need year and albums.' }, 400);
      const Y = { y: [sql.Int, year] };
      await query(`DELETE music.FavouriteAlbums WHERE Year = @y; DELETE music.FavouriteYears WHERE Year = @y;
        INSERT music.FavouriteYears (Year, Title, Note, Kind, Ranked) VALUES (@y, @t, @n, NULL, @r);`,
        { ...Y, t: [sql.NVarChar(200), String(b.title || `My favourite albums of ${year}`)], n: [sql.NVarChar(sql.MAX), b.note || null], r: [sql.Bit, !!b.ranked] });
      let i = 0;
      for (const a of b.albums) {
        await query(`INSERT music.FavouriteAlbums (Year, SortOrder, Rank, Artist, Title, Note, CoverUrl) VALUES (@y, @o, @k, @a, @ti, @n, @c)`,
          { ...Y, o: [sql.Int, ++i], k: [sql.Int, a.rank == null ? null : +a.rank], a: [sql.NVarChar(200), String(a.artist)], ti: [sql.NVarChar(300), String(a.title)],
            n: [sql.NVarChar(sql.MAX), a.note || null], c: [sql.NVarChar(500), a.cover || null] });
      }
      clearFavourites();
      return json({ ok: true, year, albums: i });
    } catch (err) { return fail(context, err); }
  }
});
