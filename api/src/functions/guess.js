const { app } = require('@azure/functions');
const {
  sql, query, json, fail, store, isOwner, prelaunch, prelaunchResponse, crypto, cat, fc, S, sharp, fetchImage, blurred, VISIBLE, ukWeek, ukDay, DAILY_FROM, guessPeriod, ukHour, dayBefore, puzzleFor, isRight, signTok, readTok, cleanName, BAD_NAME, boardTop, tallyFor, bumpTally, scoresFor, addScore, removeScore, resetDay, puzzleCached, thumbCache, MEDIA_PREFIX
} = require('../shared-releases');

app.http('guess', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'guess',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const week = guessPeriod();
      // GET /api/guess?results=2026-11-14 -> that day's answer and leaderboard (for the 11pm winners post).
      // Only for days that are over, or today from 10:30pm UK.
      const pv = request.method === 'GET' && isOwner(request) ? String(request.query.get('preview') || '') : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(pv)) {      // owner only: pick (or show) a day's cover in advance
        const pp = await puzzleFor(pv);
        return json({ day: pv, answer: pp ? { artist: pp.Artist, title: pp.Title, year: pp.ReleaseYear, id: pp.ReleaseId } : null });
      }
      const rq = request.method === 'GET' ? String(request.query.get('results') || '') : '';
      if (rq) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rq)) return json({ error: 'Use results=YYYY-MM-DD' }, 400);
        const open = rq < week || (rq === week && (ukHour() >= 23 || (ukHour() === 22 && new Date().getUTCMinutes() >= 30)));
        if (!open && !isOwner(request)) return json({ error: 'Results are available from 10:30pm UK.' }, 403);
        if (rq < DAILY_FROM) return json({ day: rq, puzzle: null, note: 'Daily puzzles start ' + DAILY_FROM }, 404);
        const rp = await puzzleCached(rq, { create: false });
        if (!rp) return json({ day: rq, puzzle: null }, 404);
        const scores = await scoresFor(rq);
        return json({ day: rq, answer: { artist: rp.Artist, title: rp.Title, year: rp.ReleaseYear, type: rp.ReleaseType, cover: rp.CoverUrl,
                      month: rp.ReleaseMonth, day: rp.ReleaseDay, bandId: rp.BandId }, tally: await tallyFor(rq), winners: boardTop(scores, 10), players: scores.length });
      }
      const p = await puzzleCached(week);
      if (!p) return json({ error: 'No puzzle today.' }, 404);
      let tally = await tallyFor(week);
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (b.resetTally && isOwner(request)) { await resetDay(week); return json({ ok: true }); }
        if (b.board) {
          if (b.remove && isOwner(request)) {
            await removeScore(week, String(b.remove));
            return json({ ok: true, board: boardTop(await scoresFor(week)) });
          }
          const w = readTok(b.win);
          if (!w || !w.win || w.w !== week) return json({ ok: false, error: 'That win has expired – have another go tomorrow!' }, 400);
          if (Date.now() - w.at > 30 * 60000) return json({ ok: false, error: 'Too late to add your name for that win, sorry.' }, 400);
          const name = cleanName(b.name);
          if (name.length < 2) return json({ ok: false, error: 'Please enter a name (2–24 characters).' }, 400);
          if (BAD_NAME.test(name.replace(/[^a-z0-9]/gi, ''))) return json({ ok: false, error: 'Please choose a different name.' }, 400);
          if (!(await addScore(week, w.id, name, w.n, Math.min(w.ms, 2e9)))) return json({ ok: false, error: "You're already on the board!" }, 400);
          const list = await scoresFor(week);
          const ranked = list;
          return json({ ok: true, place: ranked.findIndex(e => e.id === w.id) + 1, of: list.length, board: boardTop(list) });
        }
        const tk = readTok(b.token);
        const started = tk && tk.w === week ? tk : { w: week, t: Date.now(), n: 0, x: true };
        const ok = !b.giveUp && isRight(b.guess, p);
        if (!b.giveUp) { await bumpTally(week, ok); tally = { tries: tally.tries + 1, correct: tally.correct + (ok ? 1 : 0) }; }
        if (!ok && b.giveUp) return json({ correct: false, gaveUp: true, answer: { artist: p.Artist, title: p.Title, year: p.ReleaseYear, bandId: p.BandId, releaseId: p.ReleaseId, cover: p.CoverUrl, month: p.ReleaseMonth, day: p.ReleaseDay }, tally });
        const n = (started.n || 0) + (b.giveUp ? 0 : 1);
        const extra = ok && !started.x && !started.gaveUp
          ? { win: signTok({ w: week, win: true, n, ms: Date.now() - started.t, at: Date.now(), id: crypto.randomBytes(6).toString('hex') }), guesses: n, ms: Date.now() - started.t }
          : { token: signTok({ ...started, n, gaveUp: started.gaveUp || !!b.giveUp }) };
        return json({ correct: ok, ...extra, answer: ok ? { artist: p.Artist, title: p.Title, year: p.ReleaseYear, bandId: p.BandId, releaseId: p.ReleaseId, cover: p.CoverUrl,
                      month: p.ReleaseMonth, day: p.ReleaseDay } : null, tally });
      }
      const last = /-W/.test(week) ? ukWeek(new Date(Date.now() - 7 * 86400000)) : dayBefore(week);
      const lp = await puzzleCached(last, { create: false });
      const lt = await tallyFor(last);
      const letter = p.Artist.replace(/^the\s+/i, '').charAt(0).toUpperCase();
      const tw = p.Title.trim().split(/\s+/);
      const hints = { titleLetter: p.Title.replace(/^the\s+/i, '').charAt(0).toUpperCase(), titleWords: tw.length,
                      bandWords: p.Artist.trim().split(/\s+/).length, month: p.ReleaseMonth };
      const board = boardTop(await scoresFor(week));
      const lastBoard = boardTop(await scoresFor(last), 3);
      return json({ week, day: week, id: p.ReleaseId, year: p.ReleaseYear, type: p.ReleaseType, letter, hints, tally, board, lastBoard,
                    token: signTok({ w: week, t: Date.now(), n: 0 }), admin: isOwner(request),
                    lastWeek: lp ? { artist: lp.Artist, title: lp.Title, year: lp.ReleaseYear, cover: lp.CoverUrl, bandId: lp.BandId, tally: lt } : null });
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
    // The finished picture is kept in storage (social/roundup-YYYY-MM-DD.jpg) and reused until something on that
    // day is saved, so the evening round-up post (and anyone re-fetching it) doesn't wake the database.
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    let blob = null, ver = '';
    try {
      const v = await store.versions();
      ver = String(v.g) + '-' + String(v.d[`${m[2]}-${m[3]}`] || '0') + '-' + (date <= ukDay() ? 'open' : 'future');
      const { BlobServiceClient } = require('@azure/storage-blob');
      blob = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('media')
        .getBlockBlobClient(`social/roundup-${date}.jpg`);
      const props = await blob.getProperties().catch(() => null);
      if (props && props.metadata && props.metadata.ver === ver.replace(/[^0-9a-z-]/gi, '')) {
        return { status: 200, body: await blob.downloadToBuffer(), headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'hit' } };
      }
    } catch (e) { context.warn('roundup cache read failed: ' + e.message); }
    try {
      const snap = await cat.use(request);
      const fromCopy = snap ? fc.roundup(snap, month, day) : null;
      const rows = fromCopy ? fromCopy.rows : await query(
        `SELECT TOP 36 (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS Url
           FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
          WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d AND ${VISIBLE}
            AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
          ORDER BY r.ReleaseYear DESC`, { m: [sql.Int, month], d: [sql.Int, day] });
      const [{ N }] = fromCopy ? [{ N: fromCopy.N }] : await query(`SELECT COUNT(*) AS N FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId WHERE r.ReleaseMonth = @m AND r.ReleaseDay = @d AND ${VISIBLE}`,
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
      if (blob && ver) await blob.uploadData(body, { metadata: { ver: ver.replace(/[^0-9a-z-]/gi, '') },
        blobHTTPHeaders: { blobContentType: 'image/jpeg', blobCacheControl: 'public, max-age=3600' } }).catch(e => context.warn('roundup cache write failed: ' + e.message));
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/guess-image/2026-11-15.jpg -> today's mystery cover, blurred, with a "Guess the cover" banner (for social posts)
app.http('guessImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'guess-image/{week}',
  handler: async (request, context) => {
    if (prelaunch(request)) return prelaunchResponse();
    try {
      const week = guessPeriod();
      const p = await puzzleCached(week);
      if (!p) return { status: 404 };
      const S = 1080;
      const cover = await blurred(p.CoverUrl, 22, 860);
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
        <text x="${S / 2}" y="66" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="800" fill="#ececec">Guess the <tspan fill="#f2b134">cover</tspan></text>
        <text x="${S / 2}" y="${S - 40}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#cfd3d7">Released in ${p.ReleaseYear} · play at gigsintoon.co.uk</text>
      </svg>`);
      const body = await sharp()({ create: { width: S, height: S, channels: 3, background: '#111214' } })
        .composite([{ input: cover, left: 110, top: 100 }, { input: svg, left: 0, top: 0 }]).jpeg({ quality: 86 }).toBuffer();
      // Also keep a plain copy in the public media store (social/guess-YYYY-MM-DD.jpg). Instagram fetches the picture
      // when the post goes out and gave up on this generated address once (17 Nov); a stored file is instant.
      if (/^\d{4}-\d{2}-\d{2}$/.test(week)) {
        try {
          const { BlobServiceClient } = require('@azure/storage-blob');
          await BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('media')
            .getBlockBlobClient(`social/guess-${week}.jpg`).uploadData(body, { blobHTTPHeaders: { blobContentType: 'image/jpeg', blobCacheControl: 'public, max-age=86400' } });
        } catch (e) { context.warn('guess image copy failed: ' + e.message); }
      }
      return { status: 200, body, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } };
    } catch (err) { return fail(context, err); }
  }
});

app.http('thumb', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'thumb',
  handler: async (request) => {
    if (prelaunch(request)) return prelaunchResponse();
    const u = request.query.get('u') || '';
    if (!u.startsWith(MEDIA_PREFIX) || u.split(/[/?#]/).some(p => /^(\.|%2e){2}$/i.test(p))) return { status: 400, body: 'bad url' };
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
