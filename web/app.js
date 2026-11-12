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
  const chart = r.ChartPosition ? `UK No. ${r.ChartPosition}` : '';
  const when = showDate ? `${ordinal(r.ReleaseDay)} ${MONTHS[r.ReleaseMonth - 1]} ${r.ReleaseYear}` : r.ReleaseYear;
  const isNew = viewYear && r.ReleaseYear === viewYear;
  const flag = isNew ? `<span class="newflag">${isToday ? 'NEW · Out today' : 'NEW'}</span>` : '';
  const status = isAdmin && !asVisitor && r.Status
    ? `<span class="badge s-${esc(r.Status)}">${esc(STATUS_LABEL[r.Status] || r.Status)}</span>` : '';
  return `<article class="card${isNew ? ' isnew' : ''}">
    ${coverHtml(r)}
    <div class="body">
      <div class="year">${esc(when)} ${flag}</div>
      <button class="artist" data-band="${r.BandId}">${esc(r.Artist)}</button>
      <div class="title">${esc(r.Title)}</div>
      <div class="meta">${esc([r.ReleaseType, chart, r.ChartNote, r.Label].filter(Boolean).join(' · '))}</div>
      ${r.WriteUp ? `<div class="writeup">${renderWriteUp(r.WriteUp)}</div>` : ''}
      ${status ? `<div class="badges">${status}</div>` : ''}
    </div>
  </article>`;
}

function gigCard(g) {
  return `<div class="gig" data-gig="${g.GigId}" role="link" tabindex="0">
    ${g.ImageUrl ? `<img src="${esc(g.ImageUrl)}" alt="Gig ticket" loading="lazy">` : ''}
    <div><div class="year">Gig memory · ${esc(g.GigYear)}</div>
      <strong>${esc(g.Bands || '')}</strong>${g.Venue ? ` at ${esc(g.Venue)}` : ''}
      ${g.TourName ? `<div class="meta">${esc(g.TourName)}</div>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(g.WriteUp)}</div>` : ''}</div>
  </div>`;
}

// A release that's still to come this year: a clue and a blurred cover, for visitors to guess
const TYPE_WORD = { Album: 'an album', Single: 'a single', EP: 'an EP', Live: 'a live album', Compilation: 'a compilation' };
function teaserCard(t) {
  const what = TYPE_WORD[t.ReleaseType] || 'a release';
  return `<div class="card teaser">
    <div class="cover">${t.HasCover ? `<img src="/api/teaser/${t.Id}" alt="Blurred cover – can you guess it?" loading="lazy">` : '<span>?</span>'}</div>
    <div class="body"><div class="year">${esc(t.ReleaseYear)}</div>
      <div>Coming up: ${what} from ${esc(t.ReleaseYear)} by a band beginning with <strong>${esc(t.Letter)}</strong>.</div>
      <div class="meta">Can you guess it? Check back on the day.</div></div>
  </div>`;
}

async function showGig(id) {
  showOnly('gigView');
  history.replaceState(null, '', `/?gig=${id}`);
  $('gigBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { gig: g } = await api(`gigs/${id}`);
    const d = new Date(g.GigDate);
    const when = `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const bill = g.Bands.map(b => `<button class="bandlink" data-band="${b.BandId}">${esc(b.Name)}</button>`).join(' + ');
    const pics = g.Images.map(i => `<img src="${esc(i.Url)}" alt="${esc(i.AltText || i.Kind)}" loading="lazy">`).join('');
    const sets = (g.Setlist || []).map(s => `<div class="set"><h3>${esc(s.band)}</h3><ol>${(s.songs || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>`).join('');
    $('gigBody').innerHTML = `
      <div class="year">Gig memory · ${esc(when)}</div>
      <h1>${bill}</h1>
      <p class="muted">${esc([g.Venue, g.City].filter(Boolean).join(', '))}${g.TourName ? ` · ${esc(g.TourName)}` : ''}</p>
      ${g.PlaylistUrl ? `<p><a class="btn" href="${esc(g.PlaylistUrl)}" target="_blank" rel="noopener">▶ Listen to the setlist on Deezer</a></p>` : ''}
      ${pics ? `<div class="gigpics">${pics}</div>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(g.WriteUp)}</div>` : ''}
      ${sets ? `<h2>Setlist</h2><div class="sets">${sets}</div>` : ''}
      ${g.SetlistUrl ? `<p class="meta">Setlist from <a href="${esc(g.SetlistUrl)}" target="_blank" rel="noopener">setlist.fm</a></p>` : ''}`;
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
  for (const v of ['dayView', 'bandView', 'favView', 'gigView']) $(v).hidden = v !== id;
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
    $('gigs').innerHTML = data.gigs.map(gigCard).join('') + (data.gigTeasers || []).map(gigTeaserCard).join('');
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
  $('bandName').textContent = 'Loading…'; $('bandReleases').innerHTML = ''; $('bandHandles').textContent = '';
  history.pushState(null, '', `/?band=${id}`);
  try {
    const { band, releases, handles: h } = await api(`bands/${id}`);
    handles = h || {};
    $('bandName').textContent = band.Name;
    $('bandHandles').textContent = [band.XHandle && `X ${band.XHandle}`, band.InstagramHandle && `Instagram ${band.InstagramHandle}`,
      band.BlueskyHandle && `Bluesky ${band.BlueskyHandle}`, `${releases.length} release${releases.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ');
    $('bandReleases').innerHTML = releases.length
      ? releases.map(r => releaseCard(r, { showDate: true })).join('')
      : '<p class="empty">Nothing to show for this band yet.</p>';
  } catch (e) {
    $('bandName').textContent = e.message;
  }
}

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

// Admin bits in the header: link to the list page, and "view as visitor"
function renderAdminBar() {
  $('adminBar').hidden = !isAdmin;
  $('signIn').hidden = isAdmin;
  $('visitorToggle').textContent = asVisitor ? 'Viewing as visitor – switch back' : 'View as visitor';
}
$('visitorToggle').onclick = () => {
  asVisitor = !asVisitor; sessionStorageSet('asVisitor', asVisitor ? '1' : '0'); renderAdminBar(); route();
};

function route() {
  const p = new URLSearchParams(location.search);
  if (p.get('gig')) showGig(p.get('gig'));
  else if (p.get('band')) showBand(p.get('band'));
  else if (p.get('page') === 'favourites') showFavourites(p.get('year'));
  else if (/^\d{2}-\d{2}$/.test(p.get('date') || '')) {
    const [mm, dd] = p.get('date').split('-').map(Number);
    showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), mm - 1, dd)));
  } else showDay(ukToday());
}

// Count the visit (no cookies, nothing personal – see /privacy)
function countVisit() {
  try {
    fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ path: location.pathname + (location.search.startsWith('?page=') ? location.search : ''), ref: document.referrer }) });
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
      <p class="cd-tag">Every release, every gig memory – on the day it happened.</p>
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
  countVisit();
  let launch = { live: true };
  try { launch = await (await fetch('/api/launch', { cache: 'no-store' })).json(); } catch { /* assume live */ }
  isAdmin = !!launch.owner;
  if (launch.owner === undefined) { try { isAdmin = !!(await (await fetch('/api/me')).json()).owner; } catch { isAdmin = false; } }
  if (!launch.live && (!isAdmin || asVisitor)) { showCountdown(launch.launchAt, launch.now); return; }
  renderAdminBar();
  route();
})();
