// Moving off SQL, step 2: the public pages' answers worked out from the storage copy (see catalogue.js).
// Each function here gives exactly what the matching SQL in functions/*.js gives (same fields, same rules
// for what visitors can see, same order); GET /api/manage/compare checks that, page by page.
const { buildHandleMap, handlesFor, norm } = require('./handles');
const { sortBy, cmp, eqText, ukDay, d10 } = require('./catalogue');

const pad = n => String(n).padStart(2, '0');

// ---------- the visibility rules (as in functions/releases.js) ----------
function today() { const t = ukDay(); return { s: t, m: +t.slice(5, 7), d: +t.slice(8, 10) }; }
const mdReached = (m, d, T) => m < T.m || (m === T.m && d <= T.d);
const dayReached = (r, T) => mdReached(r.ReleaseMonth, r.ReleaseDay, T) && d10(r.ReleaseDate) <= T.s;
const visible = (r, T) => r.Status === 'Posted' || (r.Status === 'Drafted' && dayReached(r, T));
const artistOf = (s, r) => (r.ArtistDisplay != null ? r.ArtistDisplay : (s.bands.get(r.BandId) || {}).Name);
const firstImg = (list) => (list && list.length ? list[0].PublicUrl : null);

// RELEASE_COLUMNS + tidy()
function relRow(s, r, all, T) {
  const b = s.bands.get(r.BandId) || {};
  const imgs = s.imgRel.get(r.ReleaseId) || [];
  const o = {
    ReleaseId: r.ReleaseId, ReleaseYear: r.ReleaseYear, ReleaseMonth: r.ReleaseMonth, ReleaseDay: r.ReleaseDay, ReleaseDate: r.ReleaseDate,
    Artist: artistOf(s, r), BandId: b.BandId,
    Title: r.Title, ReleaseType: r.ReleaseType, ChartPosition: r.ChartPosition, ChartNote: r.ChartNote, Label: r.Label, ReleaseRegion: r.ReleaseRegion,
    WriteUp: r.WriteUp,
    Status: r.Status === 'Drafted' && dayReached(r, T) ? 'Posted' : r.Status,
    OnSonos: r.OnSonosPlaylist, Owned: r.Owned, NeverPost: b.NeverPost,
    CoverUrl: firstImg(imgs),
    Images: imgs.map(i => i.PublicUrl)
  };
  if (imgs.some(i => i.Kind && i.Kind !== 'Cover')) o.ImageKinds = imgs.map(i => i.Kind || 'Cover');
  if (!all) { delete o.Status; delete o.OnSonos; delete o.NeverPost; }
  return o;
}
const venueOf = (s, g) => (g.VenueAsBilled != null ? g.VenueAsBilled : ((s.venues.get(g.VenueId) || {}).Name ?? null));
function billOf(s, g) {
  const l = s.gigBands.get(g.GigId) || [];
  return l.length ? l.map(x => (s.bands.get(x.BandId) || {}).Name).join(' / ') : null;
}
// GIG_COLS
function gigRow(s, g) {
  const imgs = s.imgGig.get(g.GigId) || [];
  return { GigId: g.GigId, GigYear: +d10(g.GigDate).slice(0, 4), GigDate: g.GigDate, TourName: g.TourName, Venue: venueOf(s, g),
           Bands: billOf(s, g), ImageUrl: firstImg(imgs), ImageCount: imgs.length };
}

// @handle -> band, from the write-ups (rows in the database's own order)
let hm = { snap: null, map: null };
function handleMap(s) {
  if (hm.snap === s) return hm.map;
  const rows = s.Releases.filter(r => r.WriteUp != null).map(r => ({ BandId: r.BandId, Name: (s.bands.get(r.BandId) || {}).Name, W: String(r.WriteUp).slice(0, 800) }));
  hm = { snap: s, map: buildHandleMap(rows) };
  return hm.map;
}

function remembering(s, month, day, T) {
  const list = s.Remembering.filter(x => x.DeathMonth === month && x.DeathDay === day)
    .map(r => ({ name: r.Name, year: r.DeathYear, age: r.Age, note: r.Note, bands: JSON.parse(r.Bands || '[]') }));
  if (!list.length) return [];
  const names = [...new Set(list.flatMap(x => x.bands || []))];
  const ids = new Map();
  for (const b of s.Bands) {
    if (!names.some(n => eqText(n, b.Name))) continue;
    if (!(s.relByBand.get(b.BandId) || []).some(r => visible(r, T))) continue;
    ids.set(b.Name.toLowerCase(), b.BandId);
  }
  return list.map(x => ({ name: x.name, year: x.year, age: x.age, note: x.note || null,
    bands: (x.bands || []).filter(b => ids.has(b.toLowerCase())).map(b => ({ name: b, id: ids.get(b.toLowerCase()) })) }));
}

// ---------- the pages ----------
function onThisDay(s, month, day, all) {
  const T = today();
  const onDay = s.relByMD.get(month + '-' + day) || [];
  const releases = sortBy(onDay.filter(r => all || visible(r, T)).map(r => relRow(s, r, all, T)),
    (a, b) => b.ReleaseYear - a.ReleaseYear, (a, b) => cmp(a.Artist, b.Artist));
  const gigs = sortBy((s.gigsByMD.get(month + '-' + day) || []).filter(g => all || g.Status === 'Posted').map(g => {
    const imgs = s.imgGig.get(g.GigId) || [];
    return { GigId: g.GigId, GigYear: +d10(g.GigDate).slice(0, 4), GigDate: g.GigDate, TourName: g.TourName, WriteUp: g.WriteUp, Status: g.Status,
             Venue: venueOf(s, g), Bands: billOf(s, g), ImageUrl: firstImg(imgs), ImageCount: imgs.length, PlaylistUrl: g.PlaylistUrl };
  }), (a, b) => cmp(d10(b.GigDate), d10(a.GigDate)));
  let gigTeasers = [];
  if (!all && !mdReached(month, day, T)) {
    gigTeasers = gigs.map(g => ({ Id: g.GigId, GigYear: g.GigYear, Letter: (g.Bands || '?').replace(/^the\s+/i, '').charAt(0).toUpperCase(),
                                  Acts: (g.Bands || '').split(' / ').length, HasImage: !!g.ImageUrl }));
    gigs.length = 0;
  }
  const teasers = all ? [] : sortBy(onDay.filter(r => !visible(r, T) && r.Status !== 'DoNotPost' && !(s.bands.get(r.BandId) || {}).NeverPost && !dayReached(r, T))
    .map(r => ({ Id: r.ReleaseId, ReleaseYear: r.ReleaseYear, ReleaseType: r.ReleaseType, Letter: String(artistOf(s, r) || '').charAt(0).toUpperCase(),
                 HasCover: (s.imgRel.get(r.ReleaseId) || []).length ? 1 : 0 })), (a, b) => b.ReleaseYear - a.ReleaseYear, (a, b) => b.Id - a.Id);
  const handles = handlesFor(handleMap(s), [...releases, ...gigs].map(x => x.WriteUp));
  return { month, day, releases, gigs, teasers, gigTeasers, remembering: remembering(s, month, day, T), handles, admin: all };
}

function searchAll(s) {
  const T = today(), n = new Map();
  for (const r of s.Releases) if (visible(r, T)) n.set(r.BandId, (n.get(r.BandId) || 0) + 1);
  return { bands: sortBy([...n.entries()].map(([id, c]) => ({ BandId: id, Name: s.bands.get(id).Name, ReleaseCount: c })), (a, b) => cmp(a.Name, b.Name)) };
}
function search(s, q, all) {
  const T = today(), ql = q.toLowerCase();
  const like = (name, starts) => { const a = String(name).toLowerCase(); return starts ? a.startsWith(ql) : a.includes(ql); };
  const out = [];
  for (const b of s.Bands) {
    if (!like(b.Name)) continue;
    const c = (s.relByBand.get(b.BandId) || []).filter(r => all || visible(r, T)).length;
    if (c > 0) out.push({ BandId: b.BandId, Name: b.Name, ReleaseCount: c });
  }
  return { bands: sortBy(out, (a, b) => (like(a.Name, true) ? 0 : 1) - (like(b.Name, true) ? 0 : 1), (a, b) => cmp(a.Name, b.Name)).slice(0, 50) };
}

function band(s, id, all) {
  const b0 = s.bands.get(id);
  if (!b0) return null;
  const T = today();
  const band = { BandId: b0.BandId, Name: b0.Name, XHandle: b0.XHandle, InstagramHandle: b0.InstagramHandle, BlueskyHandle: b0.BlueskyHandle, Hashtag: b0.Hashtag, NeverPost: b0.NeverPost };
  const releases = sortBy((s.relByBand.get(id) || []).filter(r => all || visible(r, T)).map(r => relRow(s, r, all, T)), (a, b) => cmp(d10(b.ReleaseDate), d10(a.ReleaseDate)));
  const map = handleMap(s);
  if (!all) delete band.NeverPost;
  if (!band.XHandle) {
    const own = Object.entries(map).find(([, v]) => v.id === band.BandId);
    if (own) band.XHandle = '@' + own[0];
  }
  const gigs = sortBy(s.Gigs.filter(g => (s.gigBands.get(g.GigId) || []).some(x => x.BandId === id) && (all || (g.Status === 'Posted' && mdReached(g.GigMonth, g.GigDay, T))))
    .map(g => gigRow(s, g)), (a, b) => cmp(d10(b.GigDate), d10(a.GigDate)));
  return { band, releases, gigs, handles: handlesFor(map, releases.map(x => x.WriteUp)), admin: all };
}

function favouritesSource(s) {
  const years = sortBy(s.FavouriteYears.slice(), (a, b) => b.Year - a.Year);
  const albums = sortBy(s.FavouriteAlbums.slice(), (a, b) => b.Year - a.Year, (a, b) => a.SortOrder - b.SortOrder);
  return { years: years.map(y => {
    const o = { year: y.Year, title: y.Title };
    if (y.Note) o.note = y.Note; if (y.Kind) o.kind = y.Kind; if (y.Ranked) o.ranked = true;
    if (y.Kind !== 'upcoming') o.albums = albums.filter(a => a.Year === y.Year).map(a => {
      const x = { artist: a.Artist, title: a.Title }; if (a.Rank != null) x.rank = a.Rank; if (a.Note) x.note = a.Note; if (a.CoverUrl) x.cover = a.CoverUrl; return x; });
    return o; }) };
}
function favourites(s, owner) {
  const T = today();
  const rows = s.Releases.map(r => ({ BandId: r.BandId, Name: (s.bands.get(r.BandId) || {}).Name, Title: r.Title, ReleaseYear: r.ReleaseYear, CoverUrl: firstImg(s.imgRel.get(r.ReleaseId)) }));
  const byBand = new Map();
  for (const r of rows) { const k = norm(r.Name); if (!byBand.has(k)) byBand.set(k, []); byBand.get(k).push(r); }
  const bandIds = new Map(rows.map(r => [norm(r.Name), r.BandId]));
  const years = favouritesSource(s).years.map(y => ({ ...y,
    albums: (y.albums || []).map(a => {
      const cands = byBand.get(norm(a.artist)) || [];
      const t = norm(a.title);
      const hit = cands.find(c => norm(c.Title) === t) || cands.find(c => t.length > 3 && (norm(c.Title).startsWith(t) || t.startsWith(norm(c.Title))));
      return { ...a, bandId: bandIds.get(norm(a.artist)) || null, cover: a.cover || (hit && hit.CoverUrl) || null };
    }) }));
  const upcoming = sortBy(s.Releases.filter(r => d10(r.ReleaseDate) > T.s && r.Status !== 'DoNotPost').map(r => relRow(s, r, owner, T)), (a, b) => cmp(d10(a.ReleaseDate), d10(b.ReleaseDate)), (a, b) => b.ReleaseId - a.ReleaseId);
  if (!owner) upcoming.forEach(r => { r.WriteUp = null; });
  return { years, upcoming };
}

function yearsList(s, all) {
  const T = today(), m = new Map();
  const add = (y, k) => { const e = m.get(y) || { year: y, releases: 0, gigs: 0 }; e[k]++; m.set(y, e); };
  for (const r of s.Releases) if (all || visible(r, T)) add(r.ReleaseYear, 'releases');
  for (const g of s.Gigs) if (all || g.Status === 'Posted') add(+d10(g.GigDate).slice(0, 4), 'gigs');
  return { years: [...m.values()].sort((a, b) => b.year - a.year) };
}
function year(s, y, all) {
  const T = today();
  const releases = sortBy(s.Releases.filter(r => r.ReleaseYear === y && (all || visible(r, T))).map(r => relRow(s, r, all, T)),
    (a, b) => cmp(d10(a.ReleaseDate), d10(b.ReleaseDate)), (a, b) => cmp(a.Artist, b.Artist));
  const gigs = sortBy(s.Gigs.filter(g => +d10(g.GigDate).slice(0, 4) === y && (all || g.Status === 'Posted')).map(g => {
    const r = gigRow(s, g); delete r.ImageCount; return r; }), (a, b) => cmp(d10(a.GigDate), d10(b.GigDate)));
  const fav = (favouritesSource(s).years || []).find(f => f.year === y);
  return { year: y, releases, gigs, favourites: fav && fav.albums ? fav.albums.map(a => norm(a.artist) + '|' + norm(a.title)) : [], handles: handlesFor(handleMap(s), releases.map(x => x.WriteUp)) };
}

// "Newcastle University Students' Union" and "Newcastle University" are the same place (REPLACE ignores case in the database)
const venueKey = name => (name == null ? null : String(name).replace(/ Students' Union/gi, '').replace(/ Students’ Union/gi, '').replace(/ Newcastle/gi, '').replace(/^ +| +$/g, ''));
const vnOf = (s, g) => { const v = s.venues.get(g.VenueId); return venueKey(v && v.Name != null ? v.Name : g.VenueAsBilled); };
function countTop(items, keyFn, labelFn) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); if (k == null) continue; const e = m.get(k) || { label: labelFn(it), N: 0 }; e.N++; m.set(k, e); }
  return [...m.entries()];
}
function stats(s) {
  const T = today();
  const V = s.Releases.filter(r => visible(r, T));
  const posted = s.Gigs.filter(g => g.Status === 'Posted');
  const ci = k => (k == null ? null : String(k).toLowerCase());
  const tot = { Releases: V.length, Bands: new Set(V.map(r => r.BandId)).size, FirstYear: V.length ? Math.min(...V.map(r => r.ReleaseYear)) : null };
  const gt = { Gigs: posted.length, Venues: new Set(posted.map(g => ci(vnOf(s, g))).filter(x => x != null)).size };
  const topBands = sortBy(countTop(V, r => r.BandId, r => r.BandId).map(([id, e]) => ({ BandId: id, Name: s.bands.get(id).Name, N: e.N })), (a, b) => b.N - a.N, (a, b) => cmp(a.Name, b.Name)).slice(0, 15);
  const decades = sortBy(countTop(V, r => Math.floor(r.ReleaseYear / 10) * 10, () => 0).map(([k, e]) => ({ Decade: k, N: e.N })), (a, b) => a.Decade - b.Decade);
  const types = sortBy(countTop(V, r => r.ReleaseType, r => r.ReleaseType).map(([k, e]) => ({ Type: k, N: e.N })), (a, b) => b.N - a.N);
  const topYears = sortBy(countTop(V, r => r.ReleaseYear, () => 0).map(([k, e]) => ({ Year: k, N: e.N })), (a, b) => b.N - a.N).slice(0, 10);
  const gigYears = sortBy(countTop(posted, g => +d10(g.GigDate).slice(0, 4), () => 0).map(([k, e]) => ({ Year: k, N: e.N })), (a, b) => a.Year - b.Year);
  const venues = sortBy(countTop(posted.filter(g => { const v = s.venues.get(g.VenueId); return (v && v.Name != null) || g.VenueAsBilled != null; }), g => ci(vnOf(s, g)), g => vnOf(s, g))
    .map(([, e]) => ({ Venue: e.label, N: e.N })), (a, b) => b.N - a.N, (a, b) => cmp(a.Venue, b.Venue)).slice(0, 10);
  const gb = new Map();
  for (const g of posted) for (const x of s.gigBands.get(g.GigId) || []) gb.set(x.BandId, (gb.get(x.BandId) || 0) + 1);
  const gigBands = sortBy([...gb.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ BandId: id, Name: s.bands.get(id).Name, N: n })), (a, b) => b.N - a.N, (a, b) => cmp(a.Name, b.Name)).slice(0, 10);
  const ch = V.filter(r => r.ChartPosition != null);
  const charts = { Charted: ch.length, Top10: ch.length ? ch.filter(r => r.ChartPosition <= 10).length : null, No1: ch.length ? ch.filter(r => r.ChartPosition === 1).length : null };
  return { totals: { ...tot, ...gt, ...charts }, topBands, decades, types, topYears, gigYears, venues, gigBands };
}

function sitemapUrls(s) {
  const T = today();
  const urls = ['/', '/about', '/contact', '/?page=favourites', '/?page=week', '/?page=stats', '/?page=guess'];
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= new Date(Date.UTC(2024, m, 0)).getUTCDate(); d++) urls.push(`/?date=${pad(m)}-${pad(d)}`);
  const V = s.Releases.filter(r => visible(r, T));
  [...new Set(V.map(r => r.BandId))].sort((a, b) => a - b).forEach(id => urls.push(`/?band=${id}`));
  s.Gigs.filter(g => g.Status === 'Posted').forEach(g => urls.push(`/?gig=${g.GigId}`));
  [...new Set(V.map(r => r.ReleaseYear))].sort((a, b) => a - b).forEach(y => urls.push(`/?year=${y}`));
  return urls;
}

function venue(s, name, all) {
  const T = today(), want = venueKey(name);
  const gigs = sortBy(s.Gigs.filter(g => eqText(vnOf(s, g), want) && (all || (g.Status === 'Posted' && mdReached(g.GigMonth, g.GigDay, T))))
    .map(g => ({ ...gigRow(s, g), City: (s.venues.get(g.VenueId) || {}).City ?? null })), (a, b) => cmp(d10(a.GigDate), d10(b.GigDate)));
  return { venue: name.replace(/ Students['’] Union| Newcastle/g, '').trim(), city: gigs[0]?.City || null, gigs };
}

function week(s, all) {
  const T = today();
  const t0 = new Date(T.s);
  const days = [...Array(7)].map((_, i) => { const d = new Date(t0.getTime() + i * 86400000); return { m: d.getUTCMonth() + 1, d: d.getUTCDate() }; });
  const thumb = u => '/api/thumb?s=128&u=' + encodeURIComponent(u);
  return { days: days.map(({ m, d }) => {
    const rs = sortBy((s.relByMD.get(m + '-' + d) || []).map(r => ({ r, Y: r.ReleaseYear, Artist: artistOf(s, r), Title: r.Title,
      Shown: all || visible(r, T), Teaser: !visible(r, T) && r.Status !== 'DoNotPost' && !(s.bands.get(r.BandId) || {}).NeverPost && !dayReached(r, T),
      Cover: firstImg(s.imgRel.get(r.ReleaseId)) })), (a, b) => b.Y - a.Y, (a, b) => b.r.ReleaseId - a.r.ReleaseId);
    const shown = all ? rs : rs.filter(r => r.Shown), teasers = all ? [] : rs.filter(r => !r.Shown && r.Teaser);
    const thumbs = [...shown.filter(r => r.Cover).map(r => ({ u: thumb(r.Cover), t: `${r.Y} · ${r.Artist} – ${r.Title}` })),
                    ...teasers.filter(r => r.Cover).map(r => ({ u: `/api/teaser/${r.r.ReleaseId}?b=14&s=128`, t: 'Mystery release', tz: true }))].slice(0, 12);
    const n = (s.gigsByMD.get(m + '-' + d) || []).filter(g => all || g.Status === 'Posted').length;
    return { month: m, day: d, releases: shown.length + teasers.length, gigs: n, thumbs };
  }) };
}

function randomPool(s) {
  const T = today();
  return s.Releases.filter(r => visible(r, T) && (s.imgRel.get(r.ReleaseId) || []).length).map(r => [r.ReleaseId, r.ReleaseMonth, r.ReleaseDay]);
}

function gig(s, id, all) {
  const g0 = s.gigsById.get(id);
  if (!g0 || (!all && g0.Status !== 'Posted')) return null;
  const v = s.venues.get(g0.VenueId) || {};
  const g = { GigId: g0.GigId, GigDate: g0.GigDate, GigYear: +d10(g0.GigDate).slice(0, 4), TourName: g0.TourName, WriteUp: g0.WriteUp, Status: g0.Status,
              Venue: venueOf(s, g0), City: v.City ?? null, SetlistUrl: g0.SetlistUrl, PlaylistUrl: g0.PlaylistUrl };
  g.Setlist = JSON.parse(g0.SetlistJson || '[]');
  g.Bands = (s.gigBands.get(id) || []).map(x => ({ BandId: x.BandId, Name: (s.bands.get(x.BandId) || {}).Name, Billing: x.Billing }));
  g.Images = (s.imgGig.get(id) || []).map(i => ({ Url: i.PublicUrl, Kind: i.Kind, AltText: i.AltText }));
  try { g.Videos = JSON.parse(g0.VideoJson || '[]'); } catch { g.Videos = []; }
  if (!all) delete g.Status;
  return { gig: g, admin: all };
}

function links(s, ids) {
  const out = {};
  for (const id of ids) { const r = s.links.get(id); if (r) out[id] = { apple: r.AppleUrl || null, deezer: r.DeezerUrl || null }; }
  return { links: out };
}

// The first picture of a release (not do-not-post) / gig (posted), for the blurred teasers
function teaserUrl(s, kind, id) {
  if (kind === 'r') { const r = s.relById.get(id); return r && r.Status !== 'DoNotPost' ? firstImg(s.imgRel.get(id)) : null; }
  const g = s.gigsById.get(id); return g && g.Status === 'Posted' ? firstImg(s.imgGig.get(id)) : null;
}
function teaserMap(s) {
  const map = { r: {}, g: {} };
  for (const [id, l] of s.imgRel) { const r = s.relById.get(id); if (r && r.Status !== 'DoNotPost' && l.length) map.r[id] = l[0].PublicUrl; }
  for (const [id, l] of s.imgGig) { const g = s.gigsById.get(id); if (g && g.Status === 'Posted' && l.length) map.g[id] = l[0].PublicUrl; }
  return { map, count: Object.keys(map.r).length + Object.keys(map.g).length };
}
// Every band / gig / year page a visitor could ask for (nightly/urls)
function pageLists(s) {
  const pd = s.Releases.filter(r => r.Status === 'Posted' || r.Status === 'Drafted');
  return { bands: [...new Set(pd.map(r => r.BandId))], gigs: s.Gigs.filter(g => g.Status === 'Posted').map(g => g.GigId), years: [...new Set(pd.map(r => r.ReleaseYear))] };
}

// The covers for a day's round-up picture (TOP 36) and how many releases the day has
function roundup(s, month, day) {
  const T = today();
  const V = sortBy((s.relByMD.get(month + '-' + day) || []).filter(r => visible(r, T)), (a, b) => b.ReleaseYear - a.ReleaseYear);
  return { rows: V.filter(r => (s.imgRel.get(r.ReleaseId) || []).length).slice(0, 36).map(r => ({ Url: firstImg(s.imgRel.get(r.ReleaseId)) })), N: V.length };
}

module.exports = { relRow, handleMap, visible, today, onThisDay, searchAll, search, band, favourites, favouritesSource, yearsList, year, stats, sitemapUrls, venue, week, randomPool,
                   gig, links, teaserUrl, teaserMap, pageLists, roundup };
