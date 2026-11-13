const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { buildHandleMap, handlesFor, norm } = require('../handles');
const { isOwner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive } = require('../auth');
const crypto = require('crypto');
let sharpLib = null;
function sharp() { if (!sharpLib) sharpLib = require('sharp'); return sharpLib; }
const DAY_OK = (mcol, dcol) => `(${mcol} < MONTH(${UK_TODAY_EXPR}) OR (${mcol} = MONTH(${UK_TODAY_EXPR}) AND ${dcol} <= DAY(${UK_TODAY_EXPR})))`;
const UK_TODAY_EXPR = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)`;
const GIG_COLS = `g.GigId, YEAR(g.GigDate) AS GigYear, g.GigDate, g.TourName, COALESCE(g.VenueAsBilled, v.Name) AS Venue,
  (SELECT STRING_AGG(b.Name, ' / ') WITHIN GROUP (ORDER BY gb.BillOrder) FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId WHERE gb.GigId = g.GigId) AS Bands,
  (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.GigId = g.GigId ORDER BY i.SortOrder, i.ImageId) AS ImageUrl,
  (SELECT COUNT(*) FROM music.Images i WHERE i.GigId = g.GigId) AS ImageCount`;
const VENUE_NORM = `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(COALESCE(v.Name, g.VenueAsBilled), ' Students'' Union', ''), ' Students’ Union', ''), ' Newcastle', '')))`;
async function fetchImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('image ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function blurred(url, sigma, size = 600) {
  const img = sharp()(await fetchImage(url)).resize(size, size, { fit: 'cover' });
  return (sigma > 0.3 ? img.blur(sigma) : img).jpeg({ quality: 82 }).toBuffer();
}
// Favourite albums by year, from music.FavouriteYears / music.FavouriteAlbums (cached 10 minutes)
let favSrc = null, favSrcAt = 0;
async function loadFavourites() {
  if (favSrc && Date.now() - favSrcAt < 10 * 60 * 1000) return favSrc;
  const years = await query(`SELECT Year, Title, Note, Kind, Ranked FROM music.FavouriteYears ORDER BY Year DESC`);
  const albums = await query(`SELECT Year, Rank, Artist, Title, Note, CoverUrl FROM music.FavouriteAlbums ORDER BY Year DESC, SortOrder`);
  favSrc = { years: years.map(y => {
    const o = { year: y.Year, title: y.Title };
    if (y.Note) o.note = y.Note; if (y.Kind) o.kind = y.Kind; if (y.Ranked) o.ranked = true;
    if (y.Kind !== 'upcoming') o.albums = albums.filter(a => a.Year === y.Year).map(a => {
      const x = { artist: a.Artist, title: a.Title }; if (a.Rank != null) x.rank = a.Rank; if (a.Note) x.note = a.Note; if (a.CoverUrl) x.cover = a.CoverUrl; return x; });
    return o; }) };
  favSrcAt = Date.now();
  return favSrc;
}

// @handle/#hashtag -> band, rebuilt from the write-ups at most every 10 minutes
let handleCache = null, handleCacheAt = 0;
async function handleMap() {
  if (handleCache && Date.now() - handleCacheAt < 10 * 60 * 1000) return handleCache;
  const rows = await query(
    `SELECT r.BandId, b.Name, LEFT(r.WriteUp, 800) AS W
       FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
      WHERE r.WriteUp IS NOT NULL`);
  handleCache = buildHandleMap(rows);
  handleCacheAt = Date.now();
  return handleCache;
}

// Visitors only see releases that have been posted. An orange (drafted/scheduled) one counts as posted
// once its day has come round this year, the same rule the spreadsheet import uses.
const UK_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)`;
const DAY_REACHED = `((r.ReleaseMonth < MONTH(${UK_TODAY}) OR (r.ReleaseMonth = MONTH(${UK_TODAY}) AND r.ReleaseDay <= DAY(${UK_TODAY})))
  AND r.ReleaseDate <= ${UK_TODAY})`;
const VISIBLE = `(r.Status = 'Posted' OR (r.Status = 'Drafted' AND ${DAY_REACHED}))`;

const RELEASE_COLUMNS = `
  r.ReleaseId, r.ReleaseYear, r.ReleaseMonth, r.ReleaseDay, r.ReleaseDate,
  COALESCE(r.ArtistDisplay, b.Name) AS Artist, b.BandId,
  r.Title, r.ReleaseType, r.ChartPosition, r.ChartNote, r.Label, r.ReleaseRegion,
  r.WriteUp,
  -- an orange (scheduled) post counts as posted once its day has come round
  CASE WHEN r.Status = 'Drafted' AND ${DAY_REACHED} THEN 'Posted' ELSE r.Status END AS Status,
  r.OnSonosPlaylist AS OnSonos, r.Owned, b.NeverPost,
  (SELECT TOP 1 i.PublicUrl FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl,
  (SELECT i.PublicUrl AS u FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId FOR JSON PATH) AS ImagesJson`;

function tidy(rows, all) {
  return rows.map(r => {
    const images = r.ImagesJson ? JSON.parse(r.ImagesJson).map(x => x.u) : [];
    delete r.ImagesJson;
    r.Images = images;
    if (!all) { delete r.Status; delete r.OnSonos; delete r.NeverPost; }
    return r;
  });
}

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
    if (q.length < 2) return json({ bands: [] });
    const all = seesAll(request);
    try {
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

// GET /api/favourites -> favourite albums by year, with covers where the site has them,
// plus the upcoming releases (anything dated after today).
let favCache = null, favCacheAt = 0;
app.http('favourites', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'favourites',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
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
      const rows = await query(
        `SELECT TOP 1 i.PublicUrl FROM music.Images i JOIN music.Releases r ON r.ReleaseId = i.ReleaseId
          WHERE r.ReleaseId = @id AND r.Status <> 'DoNotPost' ORDER BY i.SortOrder, i.ImageId`,
        { id: [sql.Int, parseInt(request.params.id, 10)] });
      if (!rows.length) return { status: 404 };
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
      const rows = await query(
        `SELECT TOP 1 i.PublicUrl FROM music.Images i JOIN music.Gigs g ON g.GigId = i.GigId
          WHERE g.GigId = @id AND g.Status = 'Posted' ORDER BY i.SortOrder, i.ImageId`,
        { id: [sql.Int, parseInt(request.params.id, 10)] });
      if (!rows.length) return { status: 404 };
      const b = Math.max(0, Math.min(40, parseFloat(request.query.get('b') ?? '12') || 0));
      const body = await blurred(rows[0].PublicUrl, isOwner(request) && request.query.get('b') === '0' ? 0 : Math.max(b, 1.5));
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } };
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/hit {path, ref}  -> counts a page view. No cookies and nothing personal is stored:
// just the day, the page, where the visitor came from (site name only) and phone/desktop.
let hitsReady = false;
async function ensureHits() {
  if (hitsReady) return;
  await query(`IF OBJECT_ID('music.PageViews') IS NULL
    CREATE TABLE music.PageViews (
      ViewDate DATE NOT NULL, Path NVARCHAR(200) NOT NULL, RefHost NVARCHAR(200) NOT NULL, Device NVARCHAR(10) NOT NULL,
      Views INT NOT NULL DEFAULT 0,
      CONSTRAINT PK_PageViews PRIMARY KEY (ViewDate, Path, RefHost, Device))`);
  hitsReady = true;
}
app.http('hit', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'hit',
  handler: async (request, context) => {
    if (isOwner(request)) return { status: 204 };           // don't count Micky's own visits
    const ua = request.headers.get('user-agent') || '';
    if (/bot|crawl|spider|preview|monitor/i.test(ua)) return { status: 204 };
    try {
      const b = await request.json().catch(() => ({}));
      const path = String(b.path || '/').replace(/[?#].*$/, '').slice(0, 200) || '/';
      let ref = '';
      try { ref = b.ref ? new URL(b.ref).hostname.replace(/^www\./, '') : ''; } catch { ref = ''; }
      if (/gigsintoon\.co\.uk$/.test(ref)) ref = '';
      const device = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
      await ensureHits();
      await query(`MERGE music.PageViews AS t
        USING (SELECT CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE) AS ViewDate, @p AS Path, @r AS RefHost, @d AS Device) s
        ON t.ViewDate = s.ViewDate AND t.Path = s.Path AND t.RefHost = s.RefHost AND t.Device = s.Device
        WHEN MATCHED THEN UPDATE SET Views = t.Views + 1
        WHEN NOT MATCHED THEN INSERT (ViewDate, Path, RefHost, Device, Views) VALUES (s.ViewDate, s.Path, s.RefHost, s.Device, 1);`,
        { p: [sql.NVarChar(200), path], r: [sql.NVarChar(200), ref.slice(0, 200)], d: [sql.NVarChar(10), device] });
      // Rough location from the visitor's own clock setting (time zone such as Europe/London) - no IP lookups, no cookies.
      // music.PageViewPlaces is made by db/005; until then this quietly does nothing.
      const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(String(b.tz || '')) ? String(b.tz).slice(0, 60) : 'Unknown';
      await query(`MERGE music.PageViewPlaces AS t
        USING (SELECT CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE) AS ViewDate, @z AS Place) s
        ON t.ViewDate = s.ViewDate AND t.Place = s.Place
        WHEN MATCHED THEN UPDATE SET Views = t.Views + 1
        WHEN NOT MATCHED THEN INSERT (ViewDate, Place, Views) VALUES (s.ViewDate, s.Place, 1);`, { z: [sql.NVarChar(60), tz] }).catch(() => {});
      return { status: 204 };
    } catch (err) {
      context.error(err);
      return { status: 204 };
    }
  }
});

// GET /api/manage/visits?days=30 (owner only) -> page views by day, page and referrer
app.http('visits', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/visits',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const days = Math.min(365, Math.max(1, parseInt(request.query.get('days'), 10) || 30));
    try {
      await ensureHits();
      const p = { n: [sql.Int, days] };
      const since = `DATEADD(day, -@n + 1, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE))`;
      const byDay = await query(`SELECT ViewDate, SUM(Views) AS Views, SUM(CASE WHEN Device='mobile' THEN Views ELSE 0 END) AS Mobile
        FROM music.PageViews WHERE ViewDate >= ${since} GROUP BY ViewDate ORDER BY ViewDate`, p);
      const pages = await query(`SELECT TOP 20 Path, SUM(Views) AS Views FROM music.PageViews WHERE ViewDate >= ${since}
        GROUP BY Path ORDER BY Views DESC`, p);
      const refs = await query(`SELECT TOP 20 RefHost, SUM(Views) AS Views FROM music.PageViews WHERE ViewDate >= ${since} AND RefHost <> ''
        GROUP BY RefHost ORDER BY Views DESC`, p);
      const places = await query(`SELECT TOP 20 Place, SUM(Views) AS Views FROM music.PageViewPlaces WHERE ViewDate >= ${since}
        GROUP BY Place ORDER BY Views DESC`, p).catch(() => []);
      const last7 = await query(`SELECT ViewDate, SUM(Views) AS Views FROM music.PageViews
        WHERE ViewDate >= DATEADD(day, -6, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)) GROUP BY ViewDate`);
      return json({ days, byDay, pages, refs, places, last7 });
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
      const rows = await query(
        `SELECT TOP 1 r.ReleaseId, r.ReleaseMonth AS Month, r.ReleaseDay AS Day
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE ${VISIBLE} AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
          ORDER BY NEWID()`);
      return json(rows[0] || {}, 200);
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

// GET /api/stats -> numbers for the stats page (only what visitors can see)
let statsCache = null, statsAt = 0;
app.http('stats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'stats',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
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

// Guess the cover: one blurred cover a week (same for everyone), picked from releases visitors can see.
function ukWeek(d = new Date()) {
  const t = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d));
  const day = (t.getUTCDay() + 6) % 7;                 // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
async function puzzleFor(week) {
  const rows = await query(
    `SELECT r.ReleaseId, r.ReleaseYear, r.ReleaseType, r.Title, COALESCE(r.ArtistDisplay, b.Name) AS Artist, b.BandId,
            r.ReleaseMonth, r.ReleaseDay,
            (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl
       FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
      WHERE ${VISIBLE} AND r.ReleaseType IN ('Album','EP','Single')
        AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
      ORDER BY CHECKSUM(r.ReleaseId * 7919, @w) , r.ReleaseId
      OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
    { w: [sql.NVarChar(10), week] });
  return rows[0] || null;
}
const gnorm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/\b(the|a|an)\b/g, '').replace(/[^a-z0-9]/g, '');
function isRight(guess, p) {
  const g = gnorm(guess);
  if (g.length < 2) return false;
  return [p.Title, p.Artist].map(gnorm).some(t => t && (g === t || (t.length >= 4 && g.includes(t)) || (g.length >= 5 && t.includes(g) && g.length >= t.length * 0.6)));
}

// Leaderboard tokens: signed so guesses and time are counted by the server, not the browser
const boardKey = () => crypto.createHash('sha256').update('guess-board|' + (process.env.STORAGE_CONNECTION_STRING || '')).digest();
const signTok = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', boardKey()).update(b).digest('base64url'); };
function readTok(t) {
  const [b, m] = String(t || '').split('.');
  if (!b || !m) return null;
  const want = crypto.createHmac('sha256', boardKey()).update(b).digest('base64url');
  if (want.length !== m.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m))) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
}
const cleanName = n => String(n || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const BAD_NAME = /f+u+c+k|c+u+n+t|sh[i1]t|n[i1]gg|wank|tw[a@]t|bastard|bitch|slag|whore|fag|retard|penis|vagina|dick/i;
const boardTop = (list, n = 10) => list.slice().sort((a, b) => a.guesses - b.guesses || a.ms - b.ms).slice(0, n)
  .map(e => ({ id: e.id, name: e.name, guesses: e.guesses, ms: e.ms }));
// "Remembering" cards: musicians who died on this day (music.Remembering)
async function rememberingFor(month, day) {
  const list = (await query(`SELECT Name, DeathYear, Age, Note, Bands FROM music.Remembering WHERE DeathMonth = @m AND DeathDay = @d`,
    { m: [sql.TinyInt, month], d: [sql.TinyInt, day] })).map(r => ({ name: r.Name, year: r.DeathYear, age: r.Age, note: r.Note, bands: JSON.parse(r.Bands || '[]') }));
  if (!list.length) return [];
  const names = [...new Set(list.flatMap(x => x.bands || []))];
  const rows = names.length ? await query(`SELECT b.BandId, b.Name FROM music.Bands b WHERE b.Name IN (SELECT value FROM OPENJSON(@n))
      AND EXISTS (SELECT 1 FROM music.Releases r WHERE r.BandId = b.BandId AND ${VISIBLE})`, { n: [sql.NVarChar(sql.MAX), JSON.stringify(names)] }) : [];
  const ids = new Map(rows.map(r => [r.Name.toLowerCase(), r.BandId]));
  return list.map(x => ({ name: x.name, year: x.year, age: x.age, note: x.note || null,
    bands: (x.bands || []).filter(b => ids.has(b.toLowerCase())).map(b => ({ name: b, id: ids.get(b.toLowerCase()) })) }));
}
// Guess the cover tally and leaderboard live in music.GuessWeeks / music.GuessScores
async function tallyFor(week) {
  const r = await query(`SELECT Tries, Correct FROM music.GuessWeeks WHERE Week = @w`, { w: [sql.NVarChar(10), week] });
  return r[0] ? { tries: r[0].Tries, correct: r[0].Correct } : { tries: 0, correct: 0 };
}
async function bumpTally(week, ok) {
  await query(`MERGE music.GuessWeeks AS t USING (SELECT @w AS Week) s ON t.Week = s.Week
    WHEN MATCHED THEN UPDATE SET Tries = Tries + 1, Correct = Correct + @c
    WHEN NOT MATCHED THEN INSERT (Week, Tries, Correct) VALUES (@w, 1, @c);`, { w: [sql.NVarChar(10), week], c: [sql.Int, ok ? 1 : 0] });
}
async function scoresFor(week) {
  return (await query(`SELECT ScoreId, Name, Guesses, Ms FROM music.GuessScores WHERE Week = @w ORDER BY Guesses, Ms`, { w: [sql.NVarChar(10), week] }))
    .map(r => ({ id: r.ScoreId, name: r.Name, guesses: r.Guesses, ms: r.Ms }));
}
app.http('guess', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'guess',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const week = ukWeek();
      const p = await puzzleFor(week);
      if (!p) return json({ error: 'No puzzle this week.' }, 404);
      let tally = await tallyFor(week);
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const W = [sql.NVarChar(10), week];
        if (b.resetTally && isOwner(request)) { await query(`DELETE music.GuessWeeks WHERE Week = @w; DELETE music.GuessScores WHERE Week = @w;`, { w: W }); return json({ ok: true }); }
        if (b.board) {
          if (b.remove && isOwner(request)) {
            await query(`DELETE music.GuessScores WHERE Week = @w AND ScoreId = @id`, { w: W, id: [sql.NVarChar(20), String(b.remove)] });
            return json({ ok: true, board: boardTop(await scoresFor(week)) });
          }
          const w = readTok(b.win);
          if (!w || !w.win || w.w !== week) return json({ ok: false, error: 'That win has expired – have another go next week!' }, 400);
          if (Date.now() - w.at > 30 * 60000) return json({ ok: false, error: 'Too late to add your name for that win, sorry.' }, 400);
          const name = cleanName(b.name);
          if (name.length < 2) return json({ ok: false, error: 'Please enter a name (2–24 characters).' }, 400);
          if (BAD_NAME.test(name.replace(/[^a-z0-9]/gi, ''))) return json({ ok: false, error: 'Please choose a different name.' }, 400);
          const ins = await query(`IF NOT EXISTS (SELECT 1 FROM music.GuessScores WHERE ScoreId = @id)
              INSERT music.GuessScores (ScoreId, Week, Name, Guesses, Ms, CreatedAt) VALUES (@id, @w, @n, @g, @ms, SYSUTCDATETIME());
            SELECT @@ROWCOUNT AS n;`, { id: [sql.NVarChar(20), w.id], w: W, n: [sql.NVarChar(24), name], g: [sql.Int, w.n], ms: [sql.Int, Math.min(w.ms, 2e9)] });
          if (!ins[0] || !ins[0].n) return json({ ok: false, error: "You're already on the board!" }, 400);
          const list = await scoresFor(week);
          const ranked = list;
          return json({ ok: true, place: ranked.findIndex(e => e.id === w.id) + 1, of: list.length, board: boardTop(list) });
        }
        const tk = readTok(b.token);
        const started = tk && tk.w === week ? tk : { w: week, t: Date.now(), n: 0, x: true };
        const ok = !b.giveUp && isRight(b.guess, p);
        if (!b.giveUp) { await bumpTally(week, ok); tally = { tries: tally.tries + 1, correct: tally.correct + (ok ? 1 : 0) }; }
        if (!ok && b.giveUp) return json({ correct: false, gaveUp: true, answer: { artist: p.Artist, title: p.Title, year: p.ReleaseYear, bandId: p.BandId, cover: p.CoverUrl, month: p.ReleaseMonth, day: p.ReleaseDay }, tally });
        const n = (started.n || 0) + (b.giveUp ? 0 : 1);
        const extra = ok && !started.x && !started.gaveUp
          ? { win: signTok({ w: week, win: true, n, ms: Date.now() - started.t, at: Date.now(), id: crypto.randomBytes(6).toString('hex') }), guesses: n, ms: Date.now() - started.t }
          : { token: signTok({ ...started, n, gaveUp: started.gaveUp || !!b.giveUp }) };
        return json({ correct: ok, ...extra, answer: ok ? { artist: p.Artist, title: p.Title, year: p.ReleaseYear, bandId: p.BandId, cover: p.CoverUrl,
                      month: p.ReleaseMonth, day: p.ReleaseDay } : null, tally });
      }
      const last = ukWeek(new Date(Date.now() - 7 * 86400000));
      const lp = await puzzleFor(last);
      const lt = await tallyFor(last);
      const letter = p.Artist.replace(/^the\s+/i, '').charAt(0).toUpperCase();
      const tw = p.Title.trim().split(/\s+/);
      const hints = { titleLetter: p.Title.replace(/^the\s+/i, '').charAt(0).toUpperCase(), titleWords: tw.length,
                      bandWords: p.Artist.trim().split(/\s+/).length, month: p.ReleaseMonth };
      const board = boardTop(await scoresFor(week));
      const lastBoard = boardTop(await scoresFor(last), 3);
      return json({ week, id: p.ReleaseId, year: p.ReleaseYear, type: p.ReleaseType, letter, hints, tally, board, lastBoard,
                    token: signTok({ w: week, t: Date.now(), n: 0 }), admin: isOwner(request),
                    lastWeek: lp ? { artist: lp.Artist, title: lp.Title, year: lp.ReleaseYear, cover: lp.CoverUrl, bandId: lp.BandId, tally: lt } : null });
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
      const urls = ['/', '/about', '/contact', '/?page=favourites', '/?page=week', '/?page=stats', '/?page=guess'];
      for (let m = 1; m <= 12; m++) for (let d = 1; d <= new Date(Date.UTC(2024, m, 0)).getUTCDate(); d++)
        urls.push(`/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      const bands = await query(`SELECT DISTINCT r.BandId FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE ${VISIBLE}`);
      bands.forEach(b => urls.push(`/?band=${b.BandId}`));
      const gigs = await query(`SELECT GigId FROM music.Gigs WHERE Status = 'Posted'`);
      gigs.forEach(g => urls.push(`/?gig=${g.GigId}`));
      const years = await query(`SELECT DISTINCT r.ReleaseYear AS Y FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE ${VISIBLE}`);
      years.forEach(y => urls.push(`/?year=${y.Y}`));
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map(u => `  <url><loc>${base}${u.replace(/&/g, '&amp;')}</loc></url>`).join('\n') + '\n</urlset>\n';
      return { status: 200, body: xml, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/report  (header x-report-key) -> weekly summary for the email: visits, messages, to-dos.
// Only a hash of the key is kept (music.Settings); the GitHub Action that collects the report has the key as a secret.
app.http('report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'report',
  handler: async (request, context) => {
    try {
      const row = await query(`SELECT Value FROM music.Settings WHERE Name = N'ReportKeyHash'`);
      const want = row[0] ? Buffer.from(row[0].Value, 'hex') : null;
      const got = crypto.createHash('sha256').update(request.headers.get('x-report-key') || '').digest();
      if (!want || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return json({ error: 'Not allowed.' }, 403);
      let visits = null;
      try {
        const byDay = await query(`SELECT ViewDate, SUM(Views) AS Views, SUM(CASE WHEN Device='mobile' THEN Views ELSE 0 END) AS Mobile
          FROM music.PageViews WHERE ViewDate >= DATEADD(day, -7, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)) GROUP BY ViewDate ORDER BY ViewDate`);
        const pages = await query(`SELECT TOP 10 Path, SUM(Views) AS Views FROM music.PageViews WHERE ViewDate >= DATEADD(day, -7, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)) GROUP BY Path ORDER BY Views DESC`);
        const refs = await query(`SELECT TOP 10 RefHost, SUM(Views) AS Views FROM music.PageViews WHERE RefHost <> '' AND ViewDate >= DATEADD(day, -7, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)) GROUP BY RefHost ORDER BY Views DESC`);
        visits = { byDay, pages, refs };
      } catch { visits = { unavailable: 'Visitor table not set up yet (run db/003-visits-and-permissions.sql).' }; }
      const messages = (await query(`SELECT ReceivedAt, Name, Topic, LEFT(Body, 600) AS Body, CASE WHEN Email IS NULL OR Email = '' THEN 0 ELSE 1 END AS HasEmail
          FROM music.Messages WHERE IsRead = 0 AND DeletedAt IS NULL ORDER BY ReceivedAt`))
        .map(m => ({ at: m.ReceivedAt, name: m.Name, topic: m.Topic, message: m.Body, hasEmail: !!m.HasEmail }));
      const todos = (await query(`SELECT Owner, Title, Answer FROM music.Todos WHERE Done = 0 ORDER BY CreatedAt`))
        .map(t => ({ owner: t.Owner, title: t.Title, answer: t.Answer || '' }));
      const additions = (await query(`SELECT COUNT(*) AS n FROM music.SiteAdditions`))[0].n;
      const week = ukWeek(new Date(Date.now() - 7 * 86400000));
      const guess = await tallyFor(week);
      const [counts] = await query(`SELECT (SELECT COUNT(*) FROM music.Releases) AS Releases, (SELECT COUNT(*) FROM music.Gigs) AS Gigs`);
      return json({ generated: new Date().toISOString(), visits, unreadMessages: messages, openTodos: todos, siteAdditionsWaiting: additions, guessTheCover: { week, ...guess }, counts });
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
      const gigs = await query(
        `SELECT ${GIG_COLS}, v.City FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE ${VENUE_NORM} = LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(@n, ' Students'' Union', ''), ' Students’ Union', ''), ' Newcastle', '')))
            ${all ? '' : `AND g.Status = 'Posted' AND ${DAY_OK('g.GigMonth', 'g.GigDay')}`}
          ORDER BY g.GigDate`, { n: [sql.NVarChar(200), name] });
      return json({ venue: name.replace(/ Students['’] Union| Newcastle/g, '').trim(), city: gigs[0]?.City || null, gigs });
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/roundup/2026-11-14.jpg -> one image with all of that day's covers (for the evening social post)
app.http('roundup', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'roundup/{date}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:\.jpg)?$/.exec(request.params.date || '');
    if (!m) return { status: 400 };
    const month = +m[2], day = +m[3];
    try {
      const rows = await query(
        `SELECT TOP 36 (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS Url
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d AND ${VISIBLE}
            AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
          ORDER BY r.ReleaseYear DESC`, { m: [sql.Int, month], d: [sql.Int, day] });
      const [{ N }] = await query(`SELECT COUNT(*) AS N FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d AND ${VISIBLE}`,
        { m: [sql.Int, month], d: [sql.Int, day] });
      if (!rows.length) return { status: 404 };
      const S = 1080, head = 150, foot = 70;
      const cols = Math.ceil(Math.sqrt(rows.length)), rowsN = Math.ceil(rows.length / cols);
      const cell = Math.floor(Math.min(S / cols, (S - head - foot) / rowsN));
      const gridW = cell * cols, gridH = cell * rowsN;
      const ox = Math.floor((S - gridW) / 2), oy = head + Math.floor((S - head - foot - gridH) / 2);
      const tiles = await Promise.all(rows.map(async (r, i) => {
        try {
          const input = await sharp()(await fetchImage(r.Url)).resize(cell - 6, cell - 6, { fit: 'cover' }).jpeg().toBuffer();
          return { input, left: ox + (i % cols) * cell + 3, top: oy + Math.floor(i / cols) * cell + 3 };
        } catch { return null; }
      }));
      const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
      const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
        <text x="40" y="70" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="800" fill="#ececec">On this day · <tspan fill="#f2b134">${esc(ord(day) + ' ' + MON[month - 1])}</tspan></text>
        <text x="40" y="118" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#9aa0a6">${N} release${N === 1 ? '' : 's'} from my collection</text>
        <text x="${S - 40}" y="${S - 26}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="800" fill="#ececec">Gigs in <tspan fill="#f2b134">toon</tspan> · gigsintoon.co.uk</text>
      </svg>`);
      const body = await sharp()({ create: { width: S, height: S, channels: 3, background: '#111214' } })
        .composite([...tiles.filter(Boolean), { input: svg, left: 0, top: 0 }]).jpeg({ quality: 86 }).toBuffer();
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/guess-image/2026-W47.jpg -> this week's mystery cover, blurred, with a "Guess the cover" banner (for Monday's post)
app.http('guessImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'guess-image/{week}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const week = ukWeek();
      const p = await puzzleFor(week);
      if (!p) return { status: 404 };
      const S = 1080;
      const cover = await blurred(p.CoverUrl, 22, 860);
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
        <text x="${S / 2}" y="66" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="800" fill="#ececec">Guess the <tspan fill="#f2b134">cover</tspan></text>
        <text x="${S / 2}" y="${S - 40}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#cfd3d7">Released in ${p.ReleaseYear} · play at gigsintoon.co.uk</text>
      </svg>`);
      const body = await sharp()({ create: { width: S, height: S, channels: 3, background: '#111214' } })
        .composite([{ input: cover, left: 110, top: 100 }, { input: svg, left: 0, top: 0 }]).jpeg({ quality: 86 }).toBuffer();
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/health -> checks the database connection
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (request, context) => {
    try {
      const rows = await query(
        `SELECT (SELECT COUNT(*) FROM music.Bands) AS Bands,
                (SELECT COUNT(*) FROM music.Releases) AS Releases,
                (SELECT COUNT(*) FROM music.Gigs) AS Gigs`);
      return json({ ok: true, ...rows[0] });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: err.message }, 500);
    }
  }
});

// Small thumbnails of our own covers, so pages with lots of covers stay light
const thumbCache = new Map();
const MEDIA_PREFIX = 'https://gigsintoonmedia.blob.core.windows.net/media/';
app.http('thumb', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'thumb',
  handler: async (request) => {
    if (prelaunch(request)) return prelaunchResponse();
    const u = request.query.get('u') || '';
    if (!u.startsWith(MEDIA_PREFIX) || u.includes('..')) return { status: 400, body: 'bad url' };
    const size = Math.min(400, Math.max(48, parseInt(request.query.get('s') || '160', 10) || 160));
    try {
      const ck = size + '|' + u;
      let body = thumbCache.get(ck);
      if (!body) {
        body = await sharp()(await fetchImage(u)).resize(size, size, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
        thumbCache.set(ck, body);
        if (thumbCache.size > 800) thumbCache.delete(thumbCache.keys().next().value);   // keep the newest 800 in memory
      }
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' } };
    } catch { return { status: 404, body: 'not found' }; }
  }
});

// GET /api/week -> the next seven days in one go (counts and up to 12 small covers a day), cached 5 minutes
const weekCache = new Map();
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
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return json(hit.data);
    try {
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
