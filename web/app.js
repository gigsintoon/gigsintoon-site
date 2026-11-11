// Gigs in toon – front end
const $ = (id) => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const STATUS_LABEL = { NotPosted: 'Not posted', Drafted: 'Drafted', Posted: 'Posted', DoNotPost: 'Do not post' };

let current = ukToday();

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
}
function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function api(path) {
  const res = await fetch('/api/' + path, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
  return body;
}

function releaseCard(r, { showDate = false } = {}) {
  const chart = r.ChartPosition ? `UK No. ${r.ChartPosition}` : '';
  const when = showDate ? `${ordinal(r.ReleaseDay)} ${MONTHS[r.ReleaseMonth - 1]} ${r.ReleaseYear}` : r.ReleaseYear;
  const cover = r.CoverUrl ? `<img src="${esc(r.CoverUrl)}" alt="Cover of ${esc(r.Title)}" loading="lazy">` : 'No cover yet';
  return `<article class="card">
    <div class="cover">${cover}</div>
    <div class="body">
      <div class="year">${esc(when)}</div>
      <button class="artist" data-band="${r.BandId}">${esc(r.Artist)}</button>
      <div class="title">${esc(r.Title)}</div>
      <div class="meta">${esc([r.ReleaseType, chart, r.ChartNote, r.Label].filter(Boolean).join(' · '))}</div>
      ${r.WriteUp ? `<div class="writeup">${esc(r.WriteUp)}</div>` : ''}
      <div class="badges">
        <span class="badge s-${esc(r.Status)}">${esc(STATUS_LABEL[r.Status] || r.Status)}</span>
        ${r.Owned ? '<span class="badge">Owned</span>' : ''}
      </div>
    </div>
  </article>`;
}

function gigCard(g) {
  return `<div class="gig">
    ${g.ImageUrl ? `<img src="${esc(g.ImageUrl)}" alt="Gig ticket" loading="lazy">` : ''}
    <div><div class="year">Gig memory · ${esc(g.GigYear)}</div>
      <strong>${esc(g.Bands || '')}</strong>${g.Venue ? ` at ${esc(g.Venue)}` : ''}
      ${g.TourName ? `<div class="meta">${esc(g.TourName)}</div>` : ''}
      ${g.WriteUp ? `<div class="writeup">${esc(g.WriteUp)}</div>` : ''}</div>
  </div>`;
}

async function showDay(date) {
  current = date;
  const m = date.getUTCMonth() + 1, d = date.getUTCDate();
  $('bandView').hidden = true; $('dayView').hidden = false;
  $('dayTitle').textContent = `${ordinal(d)} ${MONTHS[m - 1]}`;
  $('datePick').value = date.toISOString().slice(0, 10);
  $('daySummary').textContent = 'Loading…';
  $('releases').innerHTML = ''; $('gigs').innerHTML = '';
  history.replaceState(null, '', `/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  try {
    const data = await api(`onthisday?month=${m}&day=${d}`);
    const n = data.releases.length;
    $('daySummary').textContent = n ? `${n} release${n === 1 ? '' : 's'} on this day` : '';
    $('gigs').innerHTML = data.gigs.map(gigCard).join('');
    $('releases').innerHTML = n ? data.releases.map(r => releaseCard(r)).join('')
      : '<p class="empty">Nothing recorded for this day yet.</p>';
  } catch (e) {
    $('daySummary').textContent = e.message;
  }
}

async function showBand(id) {
  $('dayView').hidden = true; $('bandView').hidden = false;
  $('bandName').textContent = 'Loading…'; $('bandReleases').innerHTML = ''; $('bandHandles').textContent = '';
  history.pushState(null, '', `/?band=${id}`);
  try {
    const { band, releases } = await api(`bands/${id}`);
    $('bandName').textContent = band.Name;
    $('bandHandles').textContent = [band.XHandle && `X ${band.XHandle}`, band.InstagramHandle && `Instagram ${band.InstagramHandle}`,
      band.BlueskyHandle && `Bluesky ${band.BlueskyHandle}`, `${releases.length} release${releases.length === 1 ? '' : 's'}`]
      .filter(Boolean).join(' · ');
    $('bandReleases').innerHTML = releases.map(r => releaseCard(r, { showDate: true })).join('');
  } catch (e) {
    $('bandName').textContent = e.message;
  }
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

// Start: ?band=12 or ?date=11-21, otherwise today
const params = new URLSearchParams(location.search);
if (params.get('band')) showBand(params.get('band'));
else if (/^\d{2}-\d{2}$/.test(params.get('date') || '')) {
  const [mm, dd] = params.get('date').split('-').map(Number);
  showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), mm - 1, dd)));
} else showDay(ukToday());
