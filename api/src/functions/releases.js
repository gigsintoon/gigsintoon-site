const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { buildHandleMap, handlesFor, norm } = require('../handles');
const { isOwner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive } = require('../auth');
const FAVOURITES = require('../favourites.json');

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
  r.Title, r.ReleaseType, r.ChartPosition, r.ChartNote, r.Label,
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
                  WHERE i.GigId = g.GigId ORDER BY i.SortOrder, i.ImageId) AS ImageUrl
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
      return json({ month, day, releases, gigs, teasers, gigTeasers, handles, admin: all });
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
      return json({ band, releases, handles: handlesFor(map, releases.map(x => x.WriteUp)), admin: all });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/favourites -> favourite albums by year (from favourites.json), with covers where the site has them,
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
        favCache = FAVOURITES.years.map(y => ({
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
      const r = await fetch(rows[0].PublicUrl);
      if (!r.ok) return { status: 404 };
      return { status: 200, body: Buffer.from(await r.arrayBuffer()),
               headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } };
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
      const r = await fetch(rows[0].PublicUrl);
      if (!r.ok) return { status: 404 };
      return { status: 200, body: Buffer.from(await r.arrayBuffer()),
               headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } };
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
      return json({ days, byDay, pages, refs });
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
