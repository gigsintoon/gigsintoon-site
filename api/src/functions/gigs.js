const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { isOwner, seesAll } = require('../auth');

// Gigs carry a setlist (JSON: [{band, songs:[...]}]), where it came from, and a playlist link.
let cols = false;
async function ensureGigColumns() {
  if (cols) return;
  await query(`
    IF COL_LENGTH('music.Gigs','Setlist') IS NULL ALTER TABLE music.Gigs ADD Setlist NVARCHAR(MAX) NULL;
    IF COL_LENGTH('music.Gigs','SetlistUrl') IS NULL ALTER TABLE music.Gigs ADD SetlistUrl NVARCHAR(400) NULL;
    IF COL_LENGTH('music.Gigs','PlaylistUrl') IS NULL ALTER TABLE music.Gigs ADD PlaylistUrl NVARCHAR(400) NULL;`);
  cols = true;
}

// GET /api/gigs/5 -> one gig with all its pictures, bill, setlist and playlist
app.http('gig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'gigs/{id:int}',
  handler: async (request, context) => {
    const all = seesAll(request);
    try {
      await ensureGigColumns();
      const id = parseInt(request.params.id, 10);
      const gigs = await query(
        `SELECT g.GigId, g.GigDate, YEAR(g.GigDate) AS GigYear, g.TourName, g.WriteUp, g.Status,
                g.Setlist, g.SetlistUrl, g.PlaylistUrl, COALESCE(g.VenueAsBilled, v.Name) AS Venue, v.City
           FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE g.GigId = @id ${all ? '' : `AND g.Status = 'Posted'`}`, { id: [sql.Int, id] });
      if (!gigs.length) return json({ error: 'Gig not found.' }, 404);
      const g = gigs[0];
      g.Setlist = g.Setlist ? JSON.parse(g.Setlist) : [];
      g.Bands = await query(
        `SELECT b.BandId, b.Name, gb.Billing FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId
          WHERE gb.GigId = @id ORDER BY gb.BillOrder`, { id: [sql.Int, id] });
      g.Images = await query(
        `SELECT PublicUrl AS Url, Kind, AltText FROM music.Images WHERE GigId = @id ORDER BY SortOrder, ImageId`, { id: [sql.Int, id] });
      if (!all) delete g.Status;
      return json({ gig: g, admin: all });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/manage/gig  (owner) – add or update a gig, matched on date + headliner.
// { date:"2008-02-24", bands:["Jimmy Eat World","Support"], venue:"O2 Academy Newcastle", city:"Newcastle",
//   tour, writeUp, status:"Posted", setlist:[{band, songs:[...]}], setlistUrl, playlistUrl,
//   images:[{path:"gig tickets/Feb 24 2008 Jimmy Eat World.JPG", kind:"Ticket"}] }
app.http('adminGig', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/gig',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      await ensureGigColumns();
      const b = await request.json();
      const bands = (b.bands || []).map(s => String(s).trim()).filter(Boolean);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !bands.length) return json({ ok: false, error: 'Give date (YYYY-MM-DD) and bands' }, 400);
      const account = ((process.env.STORAGE_CONNECTION_STRING || '').match(/AccountName=([^;]+)/) || [])[1] || 'gigsintoonmedia';
      const base = `https://${account}.blob.core.windows.net/media/`;
      const rows = await query(`
        SET XACT_ABORT ON; BEGIN TRAN;
        DECLARE @venueId INT = NULL;
        IF @venue IS NOT NULL BEGIN
          SELECT @venueId = VenueId FROM music.Venues WHERE Name = @venue;
          IF @venueId IS NULL BEGIN INSERT music.Venues (Name, City) VALUES (@venue, @city); SET @venueId = SCOPE_IDENTITY(); END
        END
        DECLARE @bandList TABLE (Ord INT, Name NVARCHAR(200));
        INSERT @bandList SELECT CAST([key] AS INT) + 1, [value] FROM OPENJSON(@bands);
        INSERT music.Bands (Name) SELECT l.Name FROM @bandList l WHERE NOT EXISTS (SELECT 1 FROM music.Bands x WHERE x.Name = l.Name);
        DECLARE @gigId INT = (SELECT TOP 1 g.GigId FROM music.Gigs g JOIN music.GigBands gb ON gb.GigId = g.GigId AND gb.BillOrder = 1
                                JOIN music.Bands x ON x.BandId = gb.BandId
                               WHERE g.GigDate = @date AND x.Name = (SELECT Name FROM @bandList WHERE Ord = 1));
        IF @gigId IS NULL BEGIN
          INSERT music.Gigs (GigDate, VenueId, VenueAsBilled, TourName, WriteUp, Status, Setlist, SetlistUrl, PlaylistUrl)
          VALUES (@date, @venueId, @venueBilled, @tour, @writeUp, @status, @setlist, @setlistUrl, @playlistUrl);
          SET @gigId = SCOPE_IDENTITY();
        END ELSE
          UPDATE music.Gigs SET VenueId = COALESCE(@venueId, VenueId), VenueAsBilled = COALESCE(@venueBilled, VenueAsBilled),
                 TourName = COALESCE(@tour, TourName), WriteUp = COALESCE(@writeUp, WriteUp), Status = @status,
                 Setlist = COALESCE(@setlist, Setlist), SetlistUrl = COALESCE(@setlistUrl, SetlistUrl),
                 PlaylistUrl = COALESCE(@playlistUrl, PlaylistUrl), UpdatedAt = SYSUTCDATETIME()
           WHERE GigId = @gigId;
        DELETE music.GigBands WHERE GigId = @gigId;
        INSERT music.GigBands (GigId, BandId, Billing, BillOrder)
          SELECT @gigId, x.BandId, CASE WHEN l.Ord = 1 THEN 'Headliner' ELSE 'Support' END, l.Ord
            FROM @bandList l JOIN music.Bands x ON x.Name = l.Name;
        IF @images IS NOT NULL BEGIN
          DELETE music.Images WHERE GigId = @gigId;
          INSERT music.Images (GigId, Kind, BlobPath, PublicUrl, SortOrder, Source)
            SELECT @gigId, COALESCE(JSON_VALUE([value], '$.kind'), 'Ticket'), JSON_VALUE([value], '$.path'),
                   @base + JSON_VALUE([value], '$.urlPath'), CAST([key] AS INT) + 1, 'Own photo'
              FROM OPENJSON(@images);
        END
        COMMIT;
        SELECT @gigId AS GigId;`, {
        date: [sql.Date, b.date], bands: [sql.NVarChar(sql.MAX), JSON.stringify(bands)],
        venue: [sql.NVarChar(200), b.venue || null], venueBilled: [sql.NVarChar(200), b.venueAsBilled || null], city: [sql.NVarChar(100), b.city || null],
        tour: [sql.NVarChar(200), b.tour || null], writeUp: [sql.NVarChar(sql.MAX), b.writeUp || null],
        status: [sql.NVarChar(20), ['NotPosted', 'Drafted', 'Posted', 'DoNotPost'].includes(b.status) ? b.status : 'Posted'],
        setlist: [sql.NVarChar(sql.MAX), b.setlist ? JSON.stringify(b.setlist) : null],
        setlistUrl: [sql.NVarChar(400), b.setlistUrl || null], playlistUrl: [sql.NVarChar(400), b.playlistUrl || null],
        images: [sql.NVarChar(sql.MAX), b.images ? JSON.stringify(b.images.map(i => ({ ...i,
          urlPath: String(i.path).split('/').map(encodeURIComponent).join('/') }))) : null],
        base: [sql.NVarChar(400), base]
      });
      return json({ ok: true, gigId: rows[0].GigId });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: err.message }, 500);
    }
  }
});
