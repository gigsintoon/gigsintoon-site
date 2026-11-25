// Shared helpers for the public API functions (releases.js, visits.js, guess.js).
// Split out of src/functions/releases.js on 25 Nov 2026 so each file stays a manageable size.
const { app } = require('@azure/functions');
const { sql, query, json, fail } = require('./db');
const store = require('./store');
const { buildHandleMap, handlesFor, norm } = require('./handles');
const { isOwner, isRunner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive } = require('./auth');
const crypto = require('crypto');
const cat = require('./catalogue');      // step 2: answers from the storage copy when the switch is on
const fc = require('./fromcatalogue');
const M = require('./master');
const S = require('./save');
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
function clearFavourites() { favSrc = null; }   // after an admin save

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
  (SELECT i.PublicUrl AS u, i.Kind AS k FROM music.Images i
     WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId FOR JSON PATH) AS ImagesJson`;

function tidy(rows, all) {
  return rows.map(r => {
    const list = r.ImagesJson ? JSON.parse(r.ImagesJson) : [];
    delete r.ImagesJson;
    r.Images = list.map(x => x.u);
    // what each picture is, when it isn't simply another cover (e.g. "Contents" for a box set): labels its button
    if (list.some(x => x.k && x.k !== 'Cover')) r.ImageKinds = list.map(x => x.k || 'Cover');
    if (!all) { delete r.Status; delete r.OnSonos; delete r.NeverPost; }
    return r;
  });
}





// GET /api/favourites -> favourite albums by year, with covers where the site has them,
// plus the upcoming releases (anything dated after today).

// The picture behind a teaser, looked up once and kept until something is saved (so blurred covers
// on day pages and in Guess the Cover don't wake the database for every visitor).
// The overnight run saves every cover/ticket address in one list (teasermap); anything newer is looked up once.
async function teaserUrl(kind, id, sqlText, request) {
  const map = await store.getStale('teasermap').catch(() => undefined);
  if (map && map[kind] && map[kind][id]) return map[kind][id];
  const snap = request ? await cat.use(request) : null;
  if (snap) return fc.teaserUrl(snap, kind, id);
  const k = `teaserurl-${kind}-${id}`;
  const have = await store.getStale(k).catch(() => undefined);
  if (have !== undefined) return have || null;
  const rows = await query(sqlText, { id: [sql.Int, id] });
  const url = rows.length ? rows[0].PublicUrl : '';
  await store.setCached(k, 's', url).catch(() => {});
  return url || null;
}



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

// Page views by day/page/referrer/place for the last n UK days, from Table Storage
const lastDays = n => { const out = []; let d = ukDay(); for (let i = 0; i < n; i++) { out.unshift(d); d = dayBefore(d); } return out; };
async function visitData(days, top = 20) {
  const ds = lastDays(days);
  // one query per table for the whole period (dates sort as text), instead of one per day
  const [pv, pl, cl] = await Promise.all([store.rowsBetween('pageviews', ds[0], ds[ds.length - 1]),
    store.rowsBetween('pageplaces', ds[0], ds[ds.length - 1]).catch(() => []),
    store.rowsBetween('clicks', ds[0], ds[ds.length - 1]).catch(() => [])]);
  // button presses: total per button, plus how many today and in the last 7 days
  const l7c = new Set(lastDays(7)), todayC = ukDay(), cm = new Map();
  for (const r of cl) { const e = cm.get(r.rk) || { Name: r.Name || r.rk, Count: 0, Last7: 0, Today: 0 }; const n = Number(r.Count || 0);
    e.Count += n; if (l7c.has(r.pk)) e.Last7 += n; if (r.pk === todayC) e.Today += n; cm.set(r.rk, e); }
  const clicks = [...cm.values()].sort((x, y) => y.Count - x.Count);
  const sum = (rows, keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (k === null) continue; m.set(k, (m.get(k) || 0) + Number(r.Views || 0)); } return m; };
  const dayMap = new Map(); for (const r of pv) { const e = dayMap.get(r.pk) || { Views: 0, Mobile: 0 }; e.Views += Number(r.Views || 0); if (r.Device === 'mobile') e.Mobile += Number(r.Views || 0); dayMap.set(r.pk, e); }
  const byDay = [...dayMap.entries()].sort().map(([d, e]) => ({ ViewDate: d + 'T00:00:00.000Z', Views: e.Views, Mobile: e.Mobile }));
  const topList = (m, name) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k, v]) => ({ [name]: k, Views: v }));
  const l7 = new Set(lastDays(7));
  return { byDay, pages: topList(sum(pv, r => r.Path || '/'), 'Path'), refs: topList(sum(pv, r => r.RefHost ? r.RefHost : null), 'RefHost'),
           places: topList(sum(pl, r => r.Place || r.rk), 'Place'),
           last7: byDay.filter(r => l7.has(r.ViewDate.slice(0, 10))).map(r => ({ ViewDate: r.ViewDate, Views: r.Views })), clicks };
}





// GET /api/stats -> numbers for the stats page (only what visitors can see)

// Guess the cover: one blurred cover a week (same for everyone), picked from releases visitors can see.
function ukWeek(d = new Date()) {
  const t = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d));
  const day = (t.getUTCDay() + 6) % 7;                 // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
// Since 15 Nov 2026 it's a new cover every day: the key is the UK date, e.g. "2026-11-14".
function ukDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
}
const DAILY_FROM = '2026-11-15';
// The puzzle key for "now": the UK date from DAILY_FROM, the ISO week before that.
const guessPeriod = (d = new Date()) => ukDay(d) >= DAILY_FROM ? ukDay(d) : ukWeek(d);
const ukHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(d)) % 24;
const dayBefore = day => { const t = new Date(day + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
// Each day's pick is saved in music.GuessPicks so it stays fixed for the day and is never used again.
let picksReady = false;
async function ensurePicks() {           // table comes from db/006-guess-daily.sql
  if (picksReady) return true;
  picksReady = !!(await query(`SELECT OBJECT_ID('music.GuessPicks') AS id`))[0].id;
  return picksReady;
}
const PUZZLE_COLS = `r.ReleaseId, r.ReleaseYear, r.ReleaseType, r.Title, COALESCE(r.ArtistDisplay, b.Name) AS Artist, b.BandId,
            r.ReleaseMonth, r.ReleaseDay,
            (SELECT TOP 1 i.PublicUrl FROM music.Images i WHERE i.ReleaseId = r.ReleaseId ORDER BY i.SortOrder, i.ImageId) AS CoverUrl`;
async function puzzleFor(period, { create = true } = {}) {
  if (await M.on()) return S.puzzle(period, { create });     // step 3: the day's pick is kept in storage
  if (/-W\d\d$/.test(period)) {          // old weekly puzzles (before the switch to daily)
    const rows = await query(
      `SELECT ${PUZZLE_COLS}
         FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
        WHERE ${VISIBLE} AND r.ReleaseType IN ('Album','EP','Single')
          AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
        ORDER BY CHECKSUM(r.ReleaseId * 7919, @w) , r.ReleaseId
        OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
      { w: [sql.NVarChar(10), period] });
    return rows[0] || null;
  }
  if (!(await ensurePicks())) {           // not set up yet: same-for-everyone pick of the day, without the no-repeat memory
    const rows = await query(
      `SELECT ${PUZZLE_COLS}
         FROM music.Releases r JOIN music.Bands b ON b.BandId = r.BandId
        WHERE ${VISIBLE} AND r.ReleaseType IN ('Album','EP','Single')
          AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
        ORDER BY CHECKSUM(r.ReleaseId * 7919, @w) , r.ReleaseId
        OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`,
      { w: [sql.NVarChar(10), period] });
    return rows[0] || null;
  }
  const P = { p: [sql.NVarChar(10), period] };
  const saved = () => query(`SELECT ${PUZZLE_COLS} FROM music.GuessPicks g JOIN music.Releases r ON r.ReleaseId = g.ReleaseId
      JOIN music.Bands b ON b.BandId = r.BandId WHERE g.Period = @p`, P);
  let rows = await saved();
  if (rows[0] || !create) return rows[0] || null;
  // Not picked yet: choose a cover that hasn't been used before (or was used longest ago, once they've all had a turn)
  await query(`IF NOT EXISTS (SELECT 1 FROM music.GuessPicks WHERE Period = @p)
    INSERT music.GuessPicks (Period, ReleaseId)
    SELECT TOP 1 @p, r.ReleaseId
      FROM music.Releases r
      LEFT JOIN (SELECT ReleaseId, MAX(PickedAt) AS LastUsed FROM music.GuessPicks GROUP BY ReleaseId) u ON u.ReleaseId = r.ReleaseId
     WHERE ${VISIBLE} AND r.ReleaseType IN ('Album','EP','Single')
       AND EXISTS (SELECT 1 FROM music.Images i WHERE i.ReleaseId = r.ReleaseId)
     ORDER BY CASE WHEN u.ReleaseId IS NULL THEN 0 ELSE 1 END, u.LastUsed, CHECKSUM(r.ReleaseId * 7919, @p), r.ReleaseId`, P)
    .catch(e => { if (!/PRIMARY KEY|duplicate/i.test(e.message)) throw e; });   // two visitors at midnight: first one wins
  rows = await saved();
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
// Guess the cover tally and leaderboard. Daily puzzles keep them in Table Storage (tables "guesstally" and
// "guessscores") so playing never wakes the SQL database; the old weekly ones stay in music.GuessWeeks / music.GuessScores.
const isDaily = period => /^\d{4}-\d{2}-\d{2}$/.test(period);
async function tallyFor(week) {
  if (isDaily(week)) { const e = await store.get('guesstally', week, 't'); return { tries: Number(e && e.Tries) || 0, correct: Number(e && e.Correct) || 0 }; }
  const r = await query(`SELECT Tries, Correct FROM music.GuessWeeks WHERE Week = @w`, { w: [sql.NVarChar(10), week] });
  return r[0] ? { tries: r[0].Tries, correct: r[0].Correct } : { tries: 0, correct: 0 };
}
async function bumpTally(week, ok) {
  if (isDaily(week)) { await store.incr('guesstally', week, 't', { Tries: 1, Correct: ok ? 1 : 0 }); return; }
  await query(`MERGE music.GuessWeeks AS t USING (SELECT @w AS Week) s ON t.Week = s.Week
    WHEN MATCHED THEN UPDATE SET Tries = Tries + 1, Correct = Correct + @c
    WHEN NOT MATCHED THEN INSERT (Week, Tries, Correct) VALUES (@w, 1, @c);`, { w: [sql.NVarChar(10), week], c: [sql.Int, ok ? 1 : 0] });
}
async function scoresFor(week) {
  if (isDaily(week)) {
    return (await store.rows('guessscores', week)).map(e => ({ id: e.rk, name: e.Name, guesses: Number(e.Guesses), ms: Number(e.Ms) }))
      .sort((x, y) => x.guesses - y.guesses || x.ms - y.ms);
  }
  return (await query(`SELECT ScoreId, Name, Guesses, Ms FROM music.GuessScores WHERE Week = @w ORDER BY Guesses, Ms`, { w: [sql.NVarChar(10), week] }))
    .map(r => ({ id: r.ScoreId, name: r.Name, guesses: r.Guesses, ms: r.Ms }));
}
async function addScore(week, id, name, guesses, ms) {
  if (isDaily(week)) return store.insertIfNew('guessscores', week, id, { Name: name, Guesses: guesses, Ms: ms, CreatedAt: new Date().toISOString() });
  const ins = await query(`IF NOT EXISTS (SELECT 1 FROM music.GuessScores WHERE ScoreId = @id)
      INSERT music.GuessScores (ScoreId, Week, Name, Guesses, Ms, CreatedAt) VALUES (@id, @w, @n, @g, @ms, SYSUTCDATETIME());
    SELECT @@ROWCOUNT AS n;`, { id: [sql.NVarChar(20), id], w: [sql.NVarChar(10), week], n: [sql.NVarChar(24), name], g: [sql.Int, guesses], ms: [sql.Int, ms] });
  return !!(ins[0] && ins[0].n);
}
async function removeScore(week, id) {
  if (isDaily(week)) return store.del('guessscores', week, id);
  await query(`DELETE music.GuessScores WHERE Week = @w AND ScoreId = @id`, { w: [sql.NVarChar(10), week], id: [sql.NVarChar(20), String(id)] });
}
async function resetDay(week) {
  if (isDaily(week)) {
    await store.del('guesstally', week, 't');
    for (const e of await store.rows('guessscores', week)) await store.del('guessscores', week, e.rk);
    return;
  }
  await query(`DELETE music.GuessWeeks WHERE Week = @w; DELETE music.GuessScores WHERE Week = @w;`, { w: [sql.NVarChar(10), week] });
}
// The day's puzzle itself is kept ready-made too (it's fixed once picked)
async function puzzleCached(period, opts) {
  if (!isDaily(period)) return puzzleFor(period, opts);
  const stamp = await store.dataVersion();
  const k = 'guess-puzzle-' + period;
  const hit = await store.getCached(k, stamp).catch(() => undefined);
  if (hit) return hit;
  const p = await puzzleFor(period, opts);
  if (p) await store.setCached(k, stamp, p).catch(() => {});
  return p;
}







// Small thumbnails of our own covers, so pages with lots of covers stay light
const thumbCache = new Map();
const MEDIA_PREFIX = 'https://gigsintoonmedia.blob.core.windows.net/media/';

// GET /api/week -> the next seven days in one go (counts and up to 12 small covers a day), cached 5 minutes
const weekCache = new Map();

module.exports = { app, sql, query, json, fail, store, buildHandleMap, handlesFor, norm, isOwner, isRunner, seesAll, prelaunch, prelaunchResponse, LAUNCH_AT, isLive, crypto, cat, fc, M, S, sharpLib, sharp, DAY_OK, UK_TODAY_EXPR, GIG_COLS, VENUE_NORM, fetchImage, blurred, favSrc, favSrcAt, loadFavourites, clearFavourites, handleCache, handleCacheAt, handleMap, UK_TODAY, DAY_REACHED, VISIBLE, RELEASE_COLUMNS, tidy, teaserUrl, hitsReady, ensureHits, lastDays, visitData, ukWeek, ukDay, DAILY_FROM, guessPeriod, ukHour, dayBefore, picksReady, ensurePicks, PUZZLE_COLS, puzzleFor, gnorm, isRight, boardKey, signTok, readTok, cleanName, BAD_NAME, boardTop, rememberingFor, isDaily, tallyFor, bumpTally, scoresFor, addScore, removeScore, resetDay, puzzleCached, thumbCache, MEDIA_PREFIX, weekCache };
