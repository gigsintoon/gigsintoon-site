const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { buildHandleMap, handlesFor, norm } = require('../handles');
const { isOwner, seesAll } = require('../auth');
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

const RELEASE_COLUMNS = `
  r.ReleaseId, r.ReleaseYear, r.ReleaseMonth, r.ReleaseDay, r.ReleaseDate,
  COALESCE(r.ArtistDisplay, b.Name) AS Artist, b.BandId,
  r.Title, r.ReleaseType, r.ChartPosition, r.ChartNote, r.Label,
  r.WriteUp, r.Status, r.OnSonosPlaylist AS OnSonos, r.Owned, b.NeverPost,
  (SELECT TOP 1 i.PublicUrl FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl,
  (SELECT i.PublicUrl AS u FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId FOR JSON PATH) AS ImagesJson`;

// Visitors only see releases that have been posted. An orange (drafted/scheduled) one counts as posted
// once its day has come round this year, the same rule the spreadsheet import uses.
const UK_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'GMT Standard Time' AS DATE)`;
const VISIBLE = `(r.Status = 'Posted' OR (r.Status = 'Drafted'
  AND (r.ReleaseMonth < MONTH(${UK_TODAY}) OR (r.ReleaseMonth = MONTH(${UK_TODAY}) AND r.ReleaseDay <= DAY(${UK_TODAY})))
  AND r.ReleaseDate <= ${UK_TODAY}))`;

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
      const handles = handlesFor(await handleMap(), [...releases, ...gigs].map(x => x.WriteUp));
      return json({ month, day, releases, gigs, handles, admin: all });
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
