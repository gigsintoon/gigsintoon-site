// Gigs in toon – front end
const $ = (id) => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const STATUS_LABEL = { NotPosted: 'Not posted', Drafted: 'Drafted', Posted: 'Posted', DoNotPost: 'Do not post' };

let current = ukToday();
let isAdmin = false;                                   // signed in as owner
const params = new URLSearchParams(location.search);
let asVisitor = sessionStorageGet('asVisitor') === '1'; // owner previewing the public view

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
}
function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Show "@badreligion" / "#SilverSun" as the band name, linked to the band page.
// Tags that aren't a band (labels, venues, people) become plain words: "#o2AcademyNewcastle" -> "o2 Academy Newcastle".
let handles = {};
function words(tag) { return tag.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); }
// The write-ups were written as "on this day" posts. On the site the card already shows the date, so lead with the year:
// "On this day in 2021 @band released…" -> "In 2021, @band released…". Display only – the text itself isn't changed.
function yearLed(text) {
  let t = String(text || '');
  t = t.replace(/^\s*(?:also,?\s+)?on\s+t?h?is\s+day,?\s+(?:in|on)?\s*(?:the\s+year\s+)?(\d{4}),?\s*/i, 'In $1, ');
  t = t.replace(/^\s*(?:also\s+)?released\s+on\s+this\s+day\s+in\s+(?:the\s+year\s+)?(\d{4})/i, 'Released in $1');
  t = t.replace(/^\s*Happy\s+Birthday\s+to\s+/i, '');
  t = t.replace(/,?\s*(?:was\s+)?released\s+on\s+this\s+day\s+in\s+(?:the\s+year\s+)?(\d{4})/i, ', released in $1');
  t = t.replace(/\bon\s+this\s+day\s+in\s+(?:the\s+year\s+)?(\d{4})/i, 'in $1');
  return t;
}
function renderWriteUp(text) {
  text = yearLed(text);
  // find the tags in the raw text first, then escape the pieces (escaping first turns ' into &#39; and the # gets eaten)
  const re = /([@#])([A-Za-z0-9_.]*[A-Za-z0-9_])/g;
  let out = '', last = 0, m;
  const seen = new Set();
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const b = handles[m[2].toLowerCase()];
    if (b) {
      // "@kingblues @kingbluesband" -> show the band once
      const prevSame = seen.has(b.id) && /^\s*$/.test(text.slice(last, m.index)) && last > 0;
      if (!prevSame) out += `<button class="bandlink" data-band="${b.id}">${esc(b.name)}</button>`;
      seen.add(b.id);
    } else out += esc(words(m[2]));
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch('/api/' + path + (isAdmin && asVisitor ? sep + 'view=public' : ''), { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
  return body;
}

// Cover, with CD1 / CD2 / CD3 buttons when a single came out on more than one CD
function coverHtml(r) {
  const imgs = (r.Images && r.Images.length ? r.Images : (r.CoverUrl ? [r.CoverUrl] : []));
  if (!imgs.length) return '<div class="cover">No cover yet</div>';
  const tabs = imgs.length > 1
    ? `<div class="cdtabs">${imgs.map((u, i) => `<button type="button" class="cdtab${i ? '' : ' on'}" data-src="${esc(u)}">CD${i + 1}</button>`).join('')}</div>`
    : '';
  return `<div class="cover"><img src="${esc(imgs[0])}" alt="Cover of ${esc(r.Title)}" loading="lazy">${tabs}</div>`;
}

function releaseCard(r, { showDate = false, viewYear = null, isToday = false } = {}) {
  const chartName = /album|compilation|live/i.test(r.ReleaseType || '') ? 'UK Albums Chart' : 'UK Singles Chart';
  const chart = r.ChartPosition ? `${chartName} No. ${r.ChartPosition}` : '';
  const note = isAdmin && !asVisitor ? r.ChartNote : null;   // chart notes are Michael's own jottings
  const when = showDate ? `${ordinal(r.ReleaseDay)} ${MONTHS[r.ReleaseMonth - 1]} ${r.ReleaseYear}` : r.ReleaseYear;
  const isNew = viewYear && r.ReleaseYear === viewYear;
  const flag = isNew ? `<span class="newflag">${isToday ? 'NEW · Out today' : 'NEW'}</span>` : '';
  const status = isAdmin && !asVisitor && r.Status
    ? `<span class="badge s-${esc(r.Status)}">${esc(STATUS_LABEL[r.Status] || r.Status)}</span>` : '';
  return `<article class="card${isNew ? ' isnew' : ''}" data-rid="${r.ReleaseId}">
    ${coverHtml(r)}
    <div class="body">
      <div class="year">${esc(when)} ${flag}</div>
      <button class="artist" data-band="${r.BandId}">${esc(r.Artist)}</button>
      <div class="title">${esc(r.Title)}</div>
      <div class="meta">${esc([r.ReleaseType, chart, note, r.Label].filter(Boolean).join(' · '))}</div>
      ${r.WriteUp ? `<div class="writeup">${renderWriteUp(r.WriteUp)}</div>` : ''}
      ${listenLinks(r)}
      ${status ? `<div class="badges">${status}</div>` : ''}
    </div>
  </article>`;
}

// Listen links search each service for "band title" (no accounts or keys needed)
function listenLinks(r) {
  const q = encodeURIComponent(`${r.Artist} ${r.Title}`.replace(/\s+(EP|Single|CD[12])$/i, ''));
  return `<div class="listen"><span>Listen:</span>
    <a href="https://music.apple.com/gb/search?term=${q}" target="_blank" rel="noopener">Apple Music</a>
    <a href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener">Spotify</a>
    <a href="https://www.deezer.com/search/${q}" target="_blank" rel="noopener">Deezer</a></div>`;
}

function gigWhen(g) { const d = new Date(g.GigDate); return `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
function gigCardDated(g) { return gigCard({ ...g, WriteUp: null }).replace(/Gig memory · \d{4}/, `Gig memory · ${gigWhen(g)}`); }

function rememberCard(x) {
  const yrs = x.year ? new Date().getUTCFullYear() - x.year : null;
  const links = (x.bands || []).map(b => `<button class="bandlink" data-band="${b.id}">${esc(b.name)}</button>`);
  return `<article class="remember">
    <div class="rk">🕯️ Remembering</div>
    <h3>${esc(x.name)}</h3>
    <p>Died on this day in ${x.year}${x.age ? `, aged ${x.age}` : ''}${yrs ? ` – ${yrs} year${yrs === 1 ? '' : 's'} ago` : ''}.</p>
    ${x.note ? `<p>${esc(x.note)}</p>` : ''}
    ${links.length ? `<p class="muted">From my collection: ${links.join(' · ')}</p>` : ''}
  </article>`;
}

function gigCard(g) {
  return `<div class="gig" data-gig="${g.GigId}" role="link" tabindex="0">
    ${g.ImageUrl ? `<img src="${esc(g.ImageUrl)}" alt="Gig ticket" loading="lazy">` : ''}
    <div><div class="year">Gig memory · ${esc(g.GigYear)}${g.ImageCount > 1 ? ` · 📷 ${g.ImageCount} photos` : ''}</div>
      <strong>${esc(g.Bands || '')}</strong>${g.Venue ? ` at <button class="bandlink" data-venue="${esc(g.Venue)}">${esc(g.Venue)}</button>` : ''}
      ${g.TourName ? `<div class="meta">${esc(g.TourName)}</div>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(g.WriteUp)}</div>` : ''}
      ${g.PlaylistUrl ? `<p class="gplay"><a href="${esc(g.PlaylistUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🎧 Listen to the setlist on Deezer</a></p>` : ''}</div>
  </div>`;
}

// A release that's still to come this year: a clue and a blurred cover, for visitors to guess
const TYPE_WORD = { Album: 'an album', Single: 'a single', EP: 'an EP', Live: 'a live album', Compilation: 'a compilation' };
function teaserCard(t) {
  const what = TYPE_WORD[t.ReleaseType] || 'a release';
  return `<div class="card teaser">
    <div class="cover">${t.HasCover ? `<img src="/api/teaser/${t.Id}?b=12" alt="Blurred cover – can you guess it?" loading="lazy">` : '<span>?</span>'}</div>
    <div class="body"><div class="year">${esc(t.ReleaseYear)}</div>
      <div>Coming up: ${what} from ${esc(t.ReleaseYear)} by a band beginning with <strong>${esc(t.Letter)}</strong>.</div>
      <div class="meta">Can you guess it? Check back on the day.</div></div>
  </div>`;
}

// Shrink a photo in the browser before upload (max 2000px, JPEG)
function shrink(file, max = 2000) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('Could not read that image')), 'image/jpeg', 0.86);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => rej(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}
async function addGigPhotos(g, files) {
  const d = g.GigDate.slice(0, 10), head = (g.Bands[0] && g.Bands[0].Name || 'Gig').replace(/[\\/:*?"<>|]/g, '');
  let n = g.Images.length;
  for (const [i, f] of files.entries()) {
    $('picMsg').textContent = `Uploading ${i + 1} of ${files.length}…`;
    try {
      const blob = await shrink(f);
      const path = `gig photos/${d} ${head} ${++n}-${Date.now().toString(36)}.jpg`;
      const up = await (await fetch('/api/manage/upload?path=' + encodeURIComponent(path), { method: 'POST', body: blob })).json();
      if (!up.ok) throw new Error(up.error || 'Upload failed');
      const r = await (await fetch('/api/manage/gig-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gigId: g.GigId, path, kind: 'Photo' }) })).json();
      if (!r.ok) throw new Error(r.error || 'Could not attach photo');
    } catch (e) { $('picMsg').textContent = `${f.name}: ${e.message}`; return; }
  }
  showGig(g.GigId);
}
// Tap a gig photo to see it full size
function openPic(n) {
  const list = window.__gigPics || []; if (!list.length) return;
  let i = n;
  const box = document.createElement('div'); box.className = 'lightbox'; box.tabIndex = -1;
  const draw = () => { box.innerHTML = `<img src="${esc(list[i])}" alt="">${list.length > 1 ? `<button class="lbp" aria-label="Previous">‹</button><button class="lbn2" aria-label="Next">›</button><span class="lbc">${i + 1} / ${list.length}</span>` : ''}<button class="lbclose" aria-label="Close">✕</button>`; };
  draw(); document.body.append(box); box.focus();
  const close = () => { box.remove(); document.removeEventListener('keydown', key); };
  const move = s => { i = (i + s + list.length) % list.length; draw(); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') move(1); if (e.key === 'ArrowLeft') move(-1); };
  document.addEventListener('keydown', key);
  box.addEventListener('click', e => { if (e.target.closest('.lbp')) move(-1); else if (e.target.closest('.lbn2')) move(1); else close(); });
}
document.addEventListener('click', async e => {
  const p = e.target.closest('[data-pic]'); if (p) { openPic(+p.dataset.pic); return; }
  const x = e.target.closest('[data-picx]'); if (!x) return;
  if (x.dataset.armed !== '1') { x.dataset.armed = '1'; x.textContent = 'Remove?'; return; }
  await fetch('/api/manage/gig-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gigId: +new URLSearchParams(location.search).get('gig'), url: x.dataset.picx, remove: true }) });
  showGig(+new URLSearchParams(location.search).get('gig'));
});

async function showGig(id) {
  showOnly('gigView');
  history.replaceState(null, '', `/?gig=${id}`);
  $('gigBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { gig: g } = await api(`gigs/${id}`);
    const d = new Date(g.GigDate);
    const when = `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const bill = g.Bands.map(b => `<button class="bandlink" data-band="${b.BandId}">${esc(b.Name)}</button>`).join(' + ');
    const pics = g.Images.map((i, n) => `<figure><button class="pic" data-pic="${n}" aria-label="View larger"><img src="${esc(i.Url)}" alt="${esc(i.AltText || i.Kind)}" loading="lazy"></button>
      ${isAdmin && !asVisitor ? `<button class="ghost picx" data-picx="${esc(i.Url)}" title="Remove this photo">✕</button>` : ''}</figure>`).join('');
    window.__gigPics = g.Images.map(i => i.Url);
    const sets = (g.Setlist || []).map(s => `<div class="set"><h3>${esc(s.band)}</h3><ol>${(s.songs || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>`).join('');
    $('gigBody').innerHTML = `
      <div class="year">Gig memory · ${esc(when)}</div>
      <h1>${bill}</h1>
      <p class="muted">${esc([g.Venue, g.City].filter(Boolean).join(', '))}${g.TourName ? ` · ${esc(g.TourName)}` : ''}</p>
      ${g.PlaylistUrl ? `<p><a class="btn" href="${esc(g.PlaylistUrl)}" target="_blank" rel="noopener">▶ Listen to the setlist on Deezer</a></p>` : ''}
      ${pics ? `<div class="gigpics${g.Images.length > 1 ? ' many' : ''}">${pics}</div>` : ''}
      ${isAdmin && !asVisitor ? `<p><label class="btn addpics">📷 Add photos<input id="addPics" type="file" accept="image/*" multiple hidden></label> <span id="picMsg" class="muted"></span></p>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(g.WriteUp)}</div>` : ''}
      ${sets ? `<h2>Setlist</h2><div class="sets">${sets}</div>` : ''}
      ${g.SetlistUrl ? `<p class="meta">Setlist from <a href="${esc(g.SetlistUrl)}" target="_blank" rel="noopener">setlist.fm</a></p>` : ''}`;
    $('addPics')?.addEventListener('change', e => addGigPhotos(g, [...e.target.files]));
  } catch (e) { $('gigBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

function gigTeaserCard(t) {
  return `<div class="gig teaser">
    ${t.HasImage ? `<div class="tblur"><img src="/api/gigteaser/${t.Id}" alt="Blurred gig ticket – can you guess it?" loading="lazy"></div>` : ''}
    <div><div class="year">Gig memory · ${esc(t.GigYear)}</div>
      <div>Coming up: a gig from ${esc(t.GigYear)}${t.Acts > 1 ? ` (a ${t.Acts}-band bill)` : ''} headlined by a band beginning with <strong>${esc(t.Letter)}</strong>.</div>
      <div class="meta">Can you guess who? Check back on the day.</div></div>
  </div>`;
}

function showOnly(id) {
  for (const v of ['dayView', 'bandView', 'favView', 'gigView', 'yearView', 'statsView', 'guessView', 'venueView', 'weekView']) $(v).hidden = v !== id;
  document.querySelectorAll('.nav a[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === id));
}

async function showDay(date) {
  current = date;
  const m = date.getUTCMonth() + 1, d = date.getUTCDate();
  showOnly('dayView');
  $('dayTitle').textContent = `${ordinal(d)} ${MONTHS[m - 1]}`;
  $('datePick').value = date.toISOString().slice(0, 10);
  $('daySummary').textContent = 'Loading…';
  $('releases').innerHTML = ''; $('gigs').innerHTML = '';
  history.replaceState(null, '', `/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  try {
    const data = await api(`onthisday?month=${m}&day=${d}`);
    handles = data.handles || {};
    const n = data.releases.length;
    const today = ukToday();
    const viewYear = today.getUTCFullYear();
    const isToday = m === today.getUTCMonth() + 1 && d === today.getUTCDate();
    const nNew = data.releases.filter(r => r.ReleaseYear === viewYear).length;
    $('daySummary').textContent = n
      ? `${n} release${n === 1 ? '' : 's'} on this day` + (nNew ? ` · ${nNew} new this year` : '')
      : '';
    $('gigs').innerHTML = (data.remembering || []).map(rememberCard).join('') + data.gigs.map(gigCard).join('') + (data.gigTeasers || []).map(gigTeaserCard).join('');
    const teasers = data.teasers || [];
    $('releases').innerHTML = (n ? data.releases.map(r => releaseCard(r, { viewYear, isToday })).join('') : '')
      + teasers.map(teaserCard).join('')
      || '<p class="empty">Nothing recorded for this day yet.</p>';
    if (teasers.length) $('daySummary').textContent += `${n ? ' · ' : ''}${teasers.length} still to come – guess them from the clues`;
  } catch (e) {
    $('daySummary').textContent = e.message;
  }
}

async function showBand(id) {
  showOnly('bandView');
  $('bandName').textContent = 'Loading…'; $('bandReleases').innerHTML = ''; $('bandGigs').innerHTML = ''; $('bandHandles').textContent = '';
  history.pushState(null, '', `/?band=${id}`);
  try {
    const { band, releases, gigs: bandGigs = [], handles: h } = await api(`bands/${id}`);
    handles = h || {};
    $('bandName').textContent = band.Name;
    $('bandHandles').textContent = [band.XHandle && `X ${band.XHandle}`, band.InstagramHandle && `Instagram ${band.InstagramHandle}`,
      band.BlueskyHandle && `Bluesky ${band.BlueskyHandle}`, `${releases.length} release${releases.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ');
    $('bandGigs').innerHTML = bandGigs.length ? `<h2>Seen live</h2>${bandGigs.map(gigCardDated).join('')}` : '';
    $('bandReleases').innerHTML = releases.length
      ? releases.map(r => releaseCard(r, { showDate: true })).join('')
      : '<p class="empty">Nothing to show for this band yet.</p>';
  } catch (e) {
    $('bandName').textContent = e.message;
  }
}

// Browse by year
async function showYear(year) {
  showOnly('yearView');
  history.replaceState(null, '', year ? `/?year=${year}` : '/?page=years');
  try {
    const { years } = await api('years');
    $('yearList').innerHTML = years.map(y => `<button type="button" class="yearbtn${String(y.year) === String(year) ? ' on' : ''}" data-year="${y.year}">${y.year}</button>`).join('');
    if (!year) { $('yearTitle').textContent = 'Browse by year'; $('yearSummary').textContent = 'Pick a year.'; $('yearBody').innerHTML = ''; $('yearGigs').innerHTML = ''; return; }
    $('yearTitle').textContent = year; $('yearSummary').textContent = 'Loading…'; $('yearBody').innerHTML = ''; $('yearGigs').innerHTML = '';
    const data = await api(`years/${year}`);
    handles = data.handles || {};
    const fav = new Set(data.favourites || []);
    const key = r => (r.Artist + '|' + r.Title).toLowerCase().replace(/\b(the|a|an)\b/g, '').replace(/&/g, 'and').replace(/[^a-z0-9|]/g, '');
    $('yearSummary').textContent = `${data.releases.length} release${data.releases.length === 1 ? '' : 's'}` + (data.gigs.length ? ` · ${data.gigs.length} gig memor${data.gigs.length === 1 ? 'y' : 'ies'}` : '') + (fav.size ? ' · ★ = one of my albums of the year' : '');
    $('yearGigs').innerHTML = data.gigs.map(gigCardDated).join('');
    $('yearBody').innerHTML = data.releases.map(r => {
      const card = releaseCard(r, { showDate: true });
      return fav.has(key(r)) ? card.replace('<article class="card', '<article class="card isfav').replace('<div class="year">', '<div class="year">★ ') : card;
    }).join('') || '<p class="empty">Nothing from this year yet.</p>';
  } catch (e) { $('yearSummary').textContent = e.message; }
}

// Venue page: every gig there
async function showVenue(name) {
  showOnly('venueView');
  history.replaceState(null, '', `/?venue=${encodeURIComponent(name)}`);
  $('venueTitle').textContent = name; $('venueBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const v = await api(`venue?name=${encodeURIComponent(name)}`);
    $('venueTitle').textContent = v.venue;
    $('venueBody').innerHTML = `<p class="muted">${v.gigs.length} gig${v.gigs.length === 1 ? '' : 's'}${v.city ? ' · ' + esc(v.city) : ''} · still adding more</p>`
      + (v.gigs.map(gigCardDated).join('') || '<p class="empty">No gigs here yet.</p>');
  } catch (e) { $('venueBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// This week: the next seven days at a glance
async function showWeek() {
  showOnly('weekView');
  history.replaceState(null, '', '/?page=week');
  $('weekBody').innerHTML = '<p class="muted">Loading…</p>';
  const start = ukToday();
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  try {
    const data = await Promise.all(days.map(d => api(`onthisday?month=${d.getUTCMonth() + 1}&day=${d.getUTCDate()}`).catch(() => null)));
    $('weekBody').innerHTML = days.map((d, i) => {
      const x = data[i] || { releases: [], gigs: [], teasers: [], gigTeasers: [] };
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const thumbs = x.releases.slice(0, 12).map(r => r.CoverUrl ? `<img src="/api/thumb?s=128&u=${encodeURIComponent(r.CoverUrl)}" alt="${esc(r.Artist + ' – ' + r.Title)}" title="${esc(r.ReleaseYear + ' · ' + r.Artist + ' – ' + r.Title)}" loading="lazy">` : '').join('')
        + (x.teasers || []).slice(0, Math.max(0, 12 - x.releases.length)).map(t => t.HasCover ? `<img class="tz" src="/api/teaser/${t.Id}?b=14&s=128" alt="Mystery cover" loading="lazy">` : '').join('');
      const n = x.releases.length + (x.teasers || []).length, g = (x.gigs || []).length + (x.gigTeasers || []).length;
      const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      return `<a class="weekday" href="/?date=${mmdd}" data-date="${mmdd}">
        <div class="wd"><b>${label}</b><span>${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}</span></div>
        <div class="wn">${n} release${n === 1 ? '' : 's'}${g ? ` · ${g} gig memor${g === 1 ? 'y' : 'ies'}` : ''}</div>
        <div class="wthumbs">${thumbs}</div></a>`;
    }).join('');
  } catch (e) { $('weekBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// Stats
function bars(rows, label, val = 'N', link) {
  const max = Math.max(1, ...rows.map(r => r[val]));
  return `<div class="bars">${rows.map(r => `<div class="barrow"><span class="bl">${link ? link(r) : esc(label(r))}</span>
    <span class="bt"><i style="width:${Math.round(r[val] / max * 100)}%"></i></span><span class="bn">${r[val]}</span></div>`).join('')}</div>`;
}
async function showStats() {
  showOnly('statsView');
  history.replaceState(null, '', '/?page=stats');
  try {
    const s = await api('stats');
    const t = s.totals;
    const bandLink = r => `<button class="bandlink" data-band="${r.BandId}">${esc(r.Name)}</button>`;
    $('statsBody').innerHTML = `
      <div class="tiles">
        <div><b>${t.Releases.toLocaleString('en-GB')}</b><span>releases</span></div>
        <div><b>${t.Bands}</b><span>bands</span></div>
        <div><b>${t.Gigs}</b><span>gig memories (and counting)</span></div>
        <div><b>${t.Venues}</b><span>venues</span></div>
        <div><b>${t.No1 || 0}</b><span>UK number ones</span></div>
        <div><b>${t.Top10 || 0}</b><span>UK top tens</span></div>
      </div>
      <div class="statgrid">
        <section><h2>Most-posted bands</h2>${bars(s.topBands, null, 'N', bandLink)}</section>
        <section><h2>Releases by decade</h2>${bars(s.decades, r => r.Decade + 's')}</section>
        <section><h2>Busiest years</h2>${bars(s.topYears, null, 'N', r => `<button class="bandlink" data-year="${r.Year}">${r.Year}</button>`)}</section>
        <section><h2>Albums, singles & EPs</h2>${bars(s.types, r => r.Type)}</section>
        <section><h2>Gigs by year</h2><p class="wip">🎫 Gig memories are a work in progress – more tickets and setlists are being added all the time.</p>${bars(s.gigYears, r => r.Year)}</section>
        <section><h2>Most-visited venues</h2><p class="wip">So far – still adding gigs!</p>${bars(s.venues, null, 'N', r => `<button class="bandlink" data-venue="${esc(r.Venue)}">${esc(r.Venue)}</button>`)}</section>
        ${s.gigBands.length ? `<section><h2>Seen live most</h2>${bars(s.gigBands, null, 'N', bandLink)}</section>` : ''}
      </div>`;
  } catch (e) { $('statsBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// Guess the cover – one a week
const MONTH_NAMES = MONTHS;
async function showGuess() {
  showOnly('guessView');
  history.replaceState(null, '', '/?page=guess');
  try {
    const g = await api('guess');
    const what = TYPE_WORD[g.type] || 'a release';
    const last = g.lastWeek;
    const h = g.hints || {};
    // Each wrong guess sharpens the picture and unlocks another clue
    const BLUR = [14, 10, 7, 4.5, 2.5];
    const CLUES = [
      `It's ${what} from <b>${g.year}</b>, by a band beginning with <b>${esc(g.letter)}</b>.`,
      `It came out in <b>${MONTH_NAMES[(h.month || 1) - 1]}</b>.`,
      `The title has <b>${h.titleWords}</b> word${h.titleWords === 1 ? '' : 's'} and starts with <b>${esc(h.titleLetter)}</b>.`,
      `The band name has <b>${h.bandWords}</b> word${h.bandWords === 1 ? '' : 's'}.`,
      `Last chance – the picture's nearly clear now!`];
    let wrong = 0, token = g.token;
    $('guessBody').innerHTML = `
      <div class="guess">
        <div class="gcover"><img src="/api/teaser/${g.id}?b=${BLUR[0]}" alt="This week's mystery cover"></div>
        <div class="gside">
          <p class="lead">Can you name this week's mystery cover? Guess the band or the title.</p>
          <ul id="clues" class="clues"><li>${CLUES[0]}</li></ul>
          <form id="guessForm" class="gform"><input name="guess" placeholder="Band or title…" autocomplete="off" maxlength="120" required>
            <button class="btn" type="submit">Guess</button></form>
          <p id="guessResult" class="muted" role="status">${g.tally.tries ? `${g.tally.correct} of ${g.tally.tries} guesses right so far this week.` : 'Be the first to have a go this week!'}</p>
          <p class="muted" style="font-size:14px">Every wrong guess makes the cover a bit clearer and gives you another clue. A new cover every Monday.</p>
          <button id="giveUp" type="button" class="ghost" hidden>I give up – show me</button>
          <div id="boardJoin"></div>
        </div>
      </div>
      <section class="board"><h2>This week's leaderboard</h2>
        <p class="muted" style="font-size:14px">Fewest guesses wins; time from opening the page breaks a tie. Adding your name is optional.</p>
        <div id="board">${boardHtml(g.board, g.admin)}</div></section>
      ${g.lastBoard && g.lastBoard.length ? `<p class="muted">Last week's winner${g.lastBoard.length > 1 ? 's' : ''}: ${g.lastBoard.map((e, i) => `${['🥇', '🥈', '🥉'][i]} <b>${esc(e.name)}</b> (${e.guesses} guess${e.guesses === 1 ? '' : 'es'}, ${fmtTime(e.ms)})`).join(' &nbsp; ')}</p>` : ''}
      ${last && last.tally.tries ? `<h2>Last week's answer</h2>
        <div class="fav"><img src="${esc(last.cover)}" alt="" loading="lazy"><div><button class="artist" data-band="${last.bandId}">${esc(last.artist)}</button>
        <div class="title">${esc(last.title)} (${last.year})</div><div class="meta">${last.tally.correct} of ${last.tally.tries} guessed it</div></div></div>` : ''}`;
    const img = document.querySelector('.gcover img');
    BLUR.slice(1).forEach(b => { const p = new Image(); p.src = `/api/teaser/${g.id}?b=${b}`; });
    const reveal = (a, text) => {
      img.src = a.cover; document.querySelector('.gcover').classList.add('revealed');
      $('guessResult').innerHTML = `${text} <b>${esc(a.artist)} – ${esc(a.title)}</b> (${a.year}). <a href="/?date=${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}">See it on its day</a>`;
      $('guessForm').remove(); $('giveUp').remove();
    };
    $('guessForm').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await fetch('/api/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guess: e.target.guess.value, token }) }).then(x => x.json());
      if (r.token) token = r.token;
      if (r.correct) {
        reveal(r.answer, wrong ? `🎉 Got it in ${wrong + 1}!` : '🎉 First time – spot on!');
        if (r.win) joinBoard(r);
        return;
      }
      wrong++;
      img.src = `/api/teaser/${g.id}?b=${BLUR[Math.min(wrong, BLUR.length - 1)]}`;
      if (CLUES[wrong]) $('clues').insertAdjacentHTML('beforeend', `<li class="new">${CLUES[wrong]}</li>`);
      $('guessResult').textContent = `Not quite – have another go! (${wrong} wrong guess${wrong === 1 ? '' : 'es'})`;
      if (wrong >= 3) $('giveUp').hidden = false;
      e.target.guess.select();
    });
    $('giveUp').addEventListener('click', async () => {
      const r = await fetch('/api/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ giveUp: true, token }) }).then(x => x.json());
      if (r.answer) reveal(r.answer, 'It was');
    });
  } catch (e) { $('guessBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`; }
function boardHtml(list, admin) {
  if (!list || !list.length) return '<p class="empty">No one on the board yet – be the first!</p>';
  return `<ol class="lb">${list.map((e, i) => `<li><span class="lbn">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><b>${esc(e.name)}</b>
    <span class="lbs">${e.guesses} guess${e.guesses === 1 ? '' : 'es'} · ${fmtTime(e.ms)}</span>${admin ? ` <button class="ghost lbx" data-lbx="${esc(e.id)}" title="Remove">✕</button>` : ''}</li>`).join('')}</ol>`;
}
function joinBoard(r) {
  $('boardJoin').innerHTML = `<form id="boardForm" class="gform lbform">
      <p>You got it in <b>${r.guesses}</b> guess${r.guesses === 1 ? '' : 'es'} and <b>${fmtTime(r.ms)}</b>. Add your name to the leaderboard?</p>
      <input name="name" placeholder="Your name" maxlength="24" autocomplete="nickname" required>
      <button class="btn" type="submit">Add me</button>
      <p id="boardMsg" class="muted" role="status"></p></form>`;
  $('boardForm').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await fetch('/api/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: true, name: e.target.name.value, win: r.win }) }).then(x => x.json());
    if (!res.ok) { $('boardMsg').textContent = res.error || 'Something went wrong.'; return; }
    $('board').innerHTML = boardHtml(res.board);
    $('boardJoin').innerHTML = `<p>🏆 You're <b>${ordinal(res.place)}</b> of ${res.of} this week!</p>`;
  });
}
document.addEventListener('click', async e => {
  const x = e.target.closest('[data-lbx]');
  if (!x) return;
  const res = await fetch('/api/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: true, remove: x.dataset.lbx }) }).then(r => r.json());
  if (res.ok) $('board').innerHTML = boardHtml(res.board, true);
});

// Favourite albums by year, plus what's coming up
async function showFavourites(year) {
  showOnly('favView');
  history.replaceState(null, '', year ? `/?page=favourites&year=${year}` : '/?page=favourites');
  $('favBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { years, upcoming } = await api('favourites');
    const pick = years.find(y => String(y.year) === String(year)) || years.find(y => y.year === 2025) || years[0];
    $('favYears').innerHTML = years.map(y =>
      `<button type="button" class="yearbtn${y === pick ? ' on' : ''}" data-favyear="${y.year}">${y.year}${y.kind === 'upcoming' ? ' (upcoming)' : ''}</button>`).join('');
    let html = `<h2>${esc(pick.title)}</h2>${pick.note ? `<p class="muted">${esc(pick.note)}</p>` : ''}`;
    if (pick.kind === 'upcoming') {
      const later = upcoming.filter(r => r.ReleaseYear >= pick.year);
      html += later.length
        ? `<div class="grid">${later.map(r => releaseCard(r, { showDate: true })).join('')}</div>`
        : '<p class="empty">Nothing announced yet.</p>';
    } else {
      const list = (pick.albums || []);
      html += list.length ? favList(list, pick.ranked) : '';
      if (pick.extra) html += `<h3>${esc(pick.extra.heading)}</h3>` + favList(pick.extra.albums, false);
      const soon = upcoming.filter(r => r.ReleaseYear === pick.year);
      if (soon.length) html += `<h3>Still to come in ${pick.year}</h3><div class="grid">${soon.map(r => releaseCard(r, { showDate: true })).join('')}</div>`;
    }
    $('favBody').innerHTML = html;
  } catch (e) {
    $('favBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
function favList(list, ranked) {
  return `<ol class="favs${ranked ? ' ranked' : ''}">${list.map(a => `<li class="fav">
      ${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : '<div class="nocover"></div>'}
      <div>${ranked && a.rank ? `<span class="rank">${a.rank}</span>` : ''}
        ${a.bandId ? `<button class="artist" data-band="${a.bandId}">${esc(a.artist)}</button>` : `<strong>${esc(a.artist)}</strong>`}
        <div class="title">${esc(a.title)}</div>
        ${a.note ? `<div class="meta">${esc(a.note)}</div>` : ''}</div>
    </li>`).join('')}</ol>`;
}

// Search
let searchTimer;
$('searchBox').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('searchBox').value.trim();
  if (q.length < 2) { $('searchResults').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { bands } = await api('search?q=' + encodeURIComponent(q));
      $('searchResults').innerHTML = bands.length
        ? bands.map(b => `<button type="button" data-band="${b.BandId}"><span>${esc(b.Name)}</span><span class="muted">${b.ReleaseCount}</span></button>`).join('')
        : '<p class="muted" style="padding:9px 12px;margin:0">No bands found</p>';
      $('searchResults').hidden = false;
    } catch (e) { /* ignore while typing */ }
  }, 250);
});
$('searchForm').addEventListener('submit', e => { e.preventDefault(); const b = $('searchResults').querySelector('button'); if (b) b.click(); });
document.addEventListener('click', e => {
  const tab = e.target.closest('.cdtab');
  if (tab) {
    const cover = tab.closest('.cover');
    cover.querySelector('img').src = tab.dataset.src;
    cover.querySelectorAll('.cdtab').forEach(t => t.classList.toggle('on', t === tab));
    return;
  }
  const wu = e.target.closest('.writeup');
  if (wu && !e.target.closest('[data-band]')) { wu.closest('.card')?.classList.toggle('open'); return; }
  const gg = e.target.closest('[data-gig]');
  if (gg && !e.target.closest('[data-band]')) { showGig(gg.dataset.gig); return; }
  const fy = e.target.closest('[data-favyear]');
  if (fy) { showFavourites(fy.dataset.favyear); return; }
  const vb = e.target.closest('[data-venue]');
  if (vb) { e.stopPropagation(); showVenue(vb.dataset.venue); return; }
  const wd = e.target.closest('[data-date]');
  if (wd) { e.preventDefault(); const [mm, dd] = wd.dataset.date.split('-').map(Number); showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), mm - 1, dd))); return; }
  const yb = e.target.closest('[data-year]');
  if (yb) { showYear(yb.dataset.year); return; }
  const b = e.target.closest('[data-band]');
  if (b) { $('searchResults').hidden = true; $('searchBox').value = ''; showBand(b.dataset.band); return; }
  if (!e.target.closest('.search')) $('searchResults').hidden = true;
});

// Day navigation
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
$('prevDay').onclick = () => showDay(addDays(current, -1));
$('nextDay').onclick = () => showDay(addDays(current, 1));
$('todayBtn').onclick = () => showDay(ukToday());
$('datePick').onchange = () => { const v = $('datePick').value; if (v) showDay(new Date(v + 'T00:00:00Z')); };
$('backBtn').onclick = () => showDay(current);
$('navDay').onclick = e => { e.preventDefault(); showDay(current); };
$('navFav').onclick = e => { e.preventDefault(); showFavourites(); };
$('navYears').onclick = e => { e.preventDefault(); showYear(); };
$('navStats').onclick = e => { e.preventDefault(); showStats(); };
$('navWeek').onclick = e => { e.preventDefault(); showWeek(); };
$('navGuess').onclick = e => { e.preventDefault(); showGuess(); };
$('surpriseBtn').onclick = async () => {
  try {
    const r = await api('random');
    if (!r.Month) return;
    await showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), r.Month - 1, r.Day)));
    const card = document.querySelector(`[data-rid="${r.ReleaseId}"]`);
    if (card) { card.classList.add('flash'); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  } catch { /* ignore */ }
};

// Admin bits in the header: link to the list page, and "view as visitor"
function renderAdminBar() {
  $('adminBar').hidden = !isAdmin;
  $('signIn').hidden = isAdmin;
  if (!isAdmin) return;
  $('adminBar').innerHTML = window.adminBarHtml(`<button id="visitorToggle" type="button" class="ghost">${asVisitor ? 'Viewing as visitor – switch back' : 'View as visitor'}</button>`);
  $('visitorToggle').onclick = () => { asVisitor = !asVisitor; sessionStorageSet('asVisitor', asVisitor ? '1' : '0'); renderAdminBar(); route(); };
}

function route() {
  if (!['/', '/index.html'].includes(location.pathname)) { location.replace('/404.html'); return; }
  const p = new URLSearchParams(location.search);
  if (p.get('gig')) showGig(p.get('gig'));
  else if (p.get('band')) showBand(p.get('band'));
  else if (p.get('page') === 'favourites') showFavourites(p.get('year'));
  else if (p.get('page') === 'years' || p.get('year')) showYear(p.get('year'));
  else if (p.get('page') === 'stats') showStats();
  else if (p.get('page') === 'week') showWeek();
  else if (p.get('venue')) showVenue(p.get('venue'));
  else if (p.get('page') === 'guess') showGuess();
  else if (/^\d{2}-\d{2}$/.test(p.get('date') || '')) {
    const [mm, dd] = p.get('date').split('-').map(Number);
    showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), mm - 1, dd)));
  } else showDay(ukToday());
}

// Count the visit (no cookies, nothing personal – see /privacy)
function countVisit(as) {
  try {
    fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ path: as || location.pathname + (location.search.startsWith('?page=') ? location.search : ''), ref: document.referrer }) });
  } catch { /* ignore */ }
}

// Before launch, visitors (and the owner when "viewing as visitor") get a countdown instead of the site.
// When it reaches zero the page reloads and the API starts answering, so the full site appears by itself.
function showCountdown(launchAt, serverNow) {
  const offset = Date.parse(serverNow) - Date.now();          // trust the server's clock, not the visitor's
  const target = Date.parse(launchAt);
  const day = new Date(target).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  const time = new Date(target).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const when = `${day} at ${time === '12:00' ? '12 noon' : time}`;
  document.body.classList.add('holding');
  const box = document.createElement('section');
  box.className = 'countdown';
  box.innerHTML = `
    <div class="cd-inner">
      <div class="cd-brand">Gigs in <span>toon</span></div>
      <p class="cd-tag">A lifetime of music I love – my collection and gig memories, on the day they happened.</p>
      <div class="cd-clock" aria-live="polite">
        <div><b id="cdD">0</b><span>days</span></div><div><b id="cdH">00</b><span>hours</span></div>
        <div><b id="cdM">00</b><span>minutes</span></div><div><b id="cdS">00</b><span>seconds</span></div>
      </div>
      <p class="cd-when">Launching ${esc(when)}</p>
      <p class="cd-follow">Follow along: <a href="https://x.com/gigsintoon">X</a> · <a href="https://www.instagram.com/gigsintoon">Instagram</a> · <a href="https://bsky.app/profile/gigsintoon.bsky.social">Bluesky</a></p>
      ${isAdmin ? '<p class="cd-admin"><button id="cdExit" type="button">Back to the admin view</button></p>' : ''}
    </div>`;
  document.body.prepend(box);
  const pad = n => String(n).padStart(2, '0');
  const tick = () => {
    const left = Math.max(0, target - (Date.now() + offset));
    const s = Math.floor(left / 1000);
    $('cdD').textContent = Math.floor(s / 86400); $('cdH').textContent = pad(Math.floor(s / 3600) % 24);
    $('cdM').textContent = pad(Math.floor(s / 60) % 60); $('cdS').textContent = pad(s % 60);
    if (left <= 0) { clearInterval(timer); box.querySelector('.cd-when').textContent = "We're live! Loading…"; setTimeout(() => location.reload(), 1500 + Math.random() * 3000); }
  };
  const timer = setInterval(tick, 250); tick();
  $('cdExit')?.addEventListener('click', () => { sessionStorageSet('asVisitor', '0'); location.reload(); });
}

(async () => {
  let launch = { live: true };
  try { launch = await (await fetch('/api/launch', { cache: 'no-store' })).json(); } catch { /* assume live */ }
  isAdmin = !!launch.owner;
  if (launch.owner === undefined) { try { isAdmin = !!(await (await fetch('/api/me')).json()).owner; } catch { isAdmin = false; } }
  if (!launch.live && (!isAdmin || asVisitor)) { countVisit('/countdown'); showCountdown(launch.launchAt, launch.now); return; }
  countVisit();
  renderAdminBar();
  route();
})();
