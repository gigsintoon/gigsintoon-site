const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { buildHandleMap, handlesFor } = require('../handles');

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
  r.WriteUp, r.Status, r.Owned, b.NeverPost,
  (SELECT TOP 1 i.PublicUrl FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl`;

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
    try {
      const releases = await query(
        `SELECT ${RELEASE_COLUMNS}
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d
          ORDER BY r.ReleaseYear, Artist`,
        { m: [sql.Int, month], d: [sql.Int, day] });
      const gigs = await query(
        `SELECT g.GigId, YEAR(g.GigDate) AS GigYear, g.GigDate, g.TourName, g.WriteUp, g.Status,
                COALESCE(g.VenueAsBilled, v.Name) AS Venue,
                (SELECT STRING_AGG(b.Name, ' / ') WITHIN GROUP (ORDER BY gb.BillOrder)
                   FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId
                  WHERE gb.GigId = g.GigId) AS Bands,
                (SELECT TOP 1 i.PublicUrl FROM music.Images i
                  WHERE i.GigId = g.GigId ORDER BY i.SortOrder, i.ImageId) AS ImageUrl
           FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE g.GigMonth = @m AND g.GigDay = @d
          ORDER BY g.GigDate`,
        { m: [sql.Int, month], d: [sql.Int, day] });
      const handles = handlesFor(await handleMap(), [...releases, ...gigs].map(x => x.WriteUp));
      return json({ month, day, releases, gigs, handles });
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
    try {
      const bands = await query(
        `SELECT TOP 50 b.BandId, b.Name,
                (SELECT COUNT(*) FROM music.Releases r WHERE r.BandId = b.BandId) AS ReleaseCount
           FROM music.Bands b
          WHERE b.Name LIKE @q
          ORDER BY CASE WHEN b.Name LIKE @starts THEN 0 ELSE 1 END, b.Name`,
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
    try {
      const bands = await query(
        `SELECT BandId, Name, XHandle, InstagramHandle, BlueskyHandle, Hashtag, NeverPost
           FROM music.Bands WHERE BandId = @id`, { id: [sql.Int, id] });
      if (!bands.length) return json({ error: 'Band not found.' }, 404);
      const releases = await query(
        `SELECT ${RELEASE_COLUMNS}
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.BandId = @id
          ORDER BY r.ReleaseDate`, { id: [sql.Int, id] });
      const map = await handleMap();
      const band = bands[0];
      if (!band.XHandle) {
        const own = Object.entries(map).find(([, v]) => v.id === band.BandId);
        if (own) band.XHandle = '@' + own[0];
      }
      return json({ band, releases, handles: handlesFor(map, releases.map(x => x.WriteUp)) });
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
