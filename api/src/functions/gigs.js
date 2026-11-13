const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('../db');
const { isOwner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive } = require('../auth');

// GET /api/gigs/5 -> one gig with all its pictures, bill, setlist and playlist
app.http('gig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'gigs/{id:int}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    const all = seesAll(request);
    try {
      const id = parseInt(request.params.id, 10);
      const gigs = await query(
        `SELECT g.GigId, g.GigDate, YEAR(g.GigDate) AS GigYear, g.TourName, g.WriteUp, g.Status,
                COALESCE(g.VenueAsBilled, v.Name) AS Venue, v.City, g.SetlistJson, g.SetlistUrl, g.PlaylistUrl
           FROM music.Gigs g LEFT JOIN music.Venues v ON v.VenueId = g.VenueId
          WHERE g.GigId = @id ${all ? '' : `AND g.Status = 'Posted'`}`, { id: [sql.Int, id] });
      if (!gigs.length) return json({ error: 'Gig not found.' }, 404);
      const g = gigs[0];
      g.Setlist = JSON.parse(g.SetlistJson || '[]'); delete g.SetlistJson;
      g.Bands = await query(
        `SELECT b.BandId, b.Name, gb.Billing FROM music.GigBands gb JOIN music.Bands b ON b.BandId = gb.BandId
          WHERE gb.GigId = @id ORDER BY gb.BillOrder`, { id: [sql.Int, id] });
      g.Images = await query(
        `SELECT PublicUrl AS Url, Kind, AltText FROM music.Images WHERE GigId = @id ORDER BY SortOrder, ImageId`, { id: [sql.Int, id] });
      // YouTube videos from the gig (column added by db/005; empty until then)
      const v = await query(`SELECT VideoJson FROM music.Gigs WHERE GigId = @id`, { id: [sql.Int, id] }).catch(() => []);
      try { g.Videos = JSON.parse((v[0] && v[0].VideoJson) || '[]'); } catch { g.Videos = []; }
      if (!all) delete g.Status;
      return json({ gig: g, admin: all });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// POST /api/manage/gig  (owner) – add or update a gig, matched on date + headliner.
// (pass id to update a specific gig, including moving its date)
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
        DECLARE @gigId INT = COALESCE((SELECT GigId FROM music.Gigs WHERE GigId = @id), (SELECT TOP 1 g.GigId FROM music.Gigs g JOIN music.GigBands gb ON gb.GigId = g.GigId AND gb.BillOrder = 1
                                JOIN music.Bands x ON x.BandId = gb.BandId
                               WHERE g.GigDate = @date AND x.Name = (SELECT Name FROM @bandList WHERE Ord = 1)));
        IF @gigId IS NULL BEGIN
          INSERT music.Gigs (GigDate, VenueId, VenueAsBilled, TourName, WriteUp, Status)
          VALUES (@date, @venueId, @venueBilled, @tour, @writeUp, @status);
          SET @gigId = SCOPE_IDENTITY();
        END ELSE
          UPDATE music.Gigs SET GigDate = @date, VenueId = COALESCE(@venueId, VenueId), VenueAsBilled = COALESCE(@venueBilled, VenueAsBilled),
                 TourName = COALESCE(@tour, TourName), WriteUp = COALESCE(@writeUp, WriteUp), Status = @status,
                 UpdatedAt = SYSUTCDATETIME()
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
        id: [sql.Int, Number.isInteger(b.id) ? b.id : null],
        date: [sql.Date, b.date], bands: [sql.NVarChar(sql.MAX), JSON.stringify(bands)],
        venue: [sql.NVarChar(200), b.venue || null], venueBilled: [sql.NVarChar(200), b.venueAsBilled || null], city: [sql.NVarChar(100), b.city || null],
        tour: [sql.NVarChar(200), b.tour || null], writeUp: [sql.NVarChar(sql.MAX), b.writeUp || null],
        status: [sql.NVarChar(20), ['NotPosted', 'Drafted', 'Posted', 'DoNotPost'].includes(b.status) ? b.status : 'Posted'],
        images: [sql.NVarChar(sql.MAX), b.images ? JSON.stringify(b.images.map(i => ({ ...i,
          urlPath: String(i.path).split('/').map(encodeURIComponent).join('/') }))) : null],
        base: [sql.NVarChar(400), base]
      });
      const gigId = rows[0].GigId;
      if (b.setlist || b.setlistUrl || b.playlistUrl) {
        await query(`UPDATE music.Gigs SET SetlistJson = COALESCE(@sl, SetlistJson), SetlistUrl = COALESCE(@su, SetlistUrl),
                       PlaylistUrl = COALESCE(@pu, PlaylistUrl) WHERE GigId = @g`, {
          g: [sql.Int, gigId], sl: [sql.NVarChar(sql.MAX), b.setlist ? JSON.stringify(b.setlist) : null],
          su: [sql.NVarChar(400), b.setlistUrl || null], pu: [sql.NVarChar(400), b.playlistUrl || null] });
      }
      let videosSaved = null;
      if (Array.isArray(b.videos)) {
        const vids = b.videos.map(x => ({ id: String(x.id || '').replace(/[^\w-]/g, '').slice(0, 20), title: String(x.title || '').slice(0, 200) })).filter(x => x.id);
        videosSaved = await query(`UPDATE music.Gigs SET VideoJson = @v WHERE GigId = @g`, { g: [sql.Int, gigId], v: [sql.NVarChar(sql.MAX), JSON.stringify(vids)] })
          .then(() => vids.length).catch(() => 'needs db/005');
      }
      return json({ ok: true, gigId, videosSaved });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: err.message }, 500);
    }
  }
});

// POST /api/manage/gig-image (owner) { gigId, path, kind } adds a photo; { gigId, url, remove: true } takes one off
app.http('adminGigImage', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/gig-image',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const gigId = parseInt(b.gigId, 10);
      if (!gigId) return json({ ok: false, error: 'Give gigId' }, 400);
      if (b.remove) {
        await query(`DELETE music.Images WHERE GigId = @g AND PublicUrl = @u`, { g: [sql.Int, gigId], u: [sql.NVarChar(800), String(b.url || '')] });
        return json({ ok: true });
      }
      const path = String(b.path || '').replace(/^\/+/, '');
      if (!path || path.includes('..')) return json({ ok: false, error: 'Give path' }, 400);
      const account = ((process.env.STORAGE_CONNECTION_STRING || '').match(/AccountName=([^;]+)/) || [])[1] || 'gigsintoonmedia';
      const url = `https://${account}.blob.core.windows.net/media/` + path.split('/').map(encodeURIComponent).join('/');
      await query(`INSERT music.Images (GigId, Kind, BlobPath, PublicUrl, SortOrder, Source)
                    SELECT @g, @k, @p, @u, COALESCE(MAX(SortOrder), 0) + 1, 'Own photo' FROM music.Images WHERE GigId = @g`,
        { g: [sql.Int, gigId], k: [sql.NVarChar(20), ['Ticket', 'Photo', 'Setlist', 'Poster'].includes(b.kind) ? b.kind : 'Photo'],
          p: [sql.NVarChar(400), path], u: [sql.NVarChar(800), url] });
      return json({ ok: true, url });
    } catch (err) { context.error(err); return json({ ok: false, error: err.message }, 500); }
  }
});

// POST /api/manage/gig-delete (owner) { id, confirm: true } removes a gig (its bands and images links go with it).
// Without confirm it just shows what would be deleted.
app.http('adminGigDelete', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/gig-delete',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      const b = await request.json();
      const id = parseInt(b.id, 10);
      if (!id) return json({ ok: false, error: 'Give id' }, 400);
      const rows = await query(`SELECT g.GigId, g.GigDate, (SELECT STRING_AGG(x.Name, ', ') FROM music.GigBands gb JOIN music.Bands x ON x.BandId = gb.BandId WHERE gb.GigId = g.GigId) AS Bands
                                  FROM music.Gigs g WHERE g.GigId = @id`, { id: [sql.Int, id] });
      if (!rows.length) return json({ ok: false, error: 'No gig with that id' }, 404);
      if (b.confirm !== true) return json({ ok: true, preview: rows[0] });
      await query(`DELETE music.Gigs WHERE GigId = @id`, { id: [sql.Int, id] });
      return json({ ok: true, deleted: rows[0] });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: String(err.message || err) }, 500);
    }
  }
});
