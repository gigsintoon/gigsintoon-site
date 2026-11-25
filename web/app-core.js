// Gigs in toon front end, part 1 of 5: Helpers, release and gig cards, listen links, photo viewer.
// The five app*.js files share one global scope and load in order (index.html): core, pages, games, search, then app.js.
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

async function api(path, attempt = 1) {
  const sep = path.includes('?') ? '&' : '?';
  let res, body;
  try {
    res = await fetch('/api/' + path + (isAdmin && asVisitor ? sep + 'view=public' : ''), { headers: { Accept: 'application/json' } });
    body = await res.json().catch(() => ({}));
  } catch (e) { res = { ok: false, status: 0 }; body = {}; }
  // The database can take a few seconds to wake after a quiet spell: wait and try again rather than show an error
  if ((!res.ok && (res.status === 0 || res.status >= 500)) && attempt < 3) {
    showWaking(true);
    await new Promise(r => setTimeout(r, 2500 * attempt));
    try { return await api(path, attempt + 1); } finally { if (attempt === 1) showWaking(false); }
  }
  if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
  return body;
}
function showWaking(on) {
  let el = document.getElementById('wakingNote');
  if (on && !el) {
    el = document.createElement('div'); el.id = 'wakingNote'; el.setAttribute('role', 'status');
    el.textContent = '⏳ Just a moment – waking things up…';
    el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:20px;font-size:14px;z-index:999;box-shadow:0 2px 10px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  } else if (!on && el) el.remove();
}

// Cover, with CD1 / CD2 / CD3 buttons when a single came out on more than one CD
// (or named buttons, e.g. Cover / Contents, when the pictures are labelled with what they show)
const KIND_LABEL = { Cover: 'Cover', Back: 'Back', Other: 'Contents' };
const imageLabel = (r, i) => (r.ImageKinds && (KIND_LABEL[r.ImageKinds[i]] || r.ImageKinds[i])) || `CD${i + 1}`;
function coverHtml(r) {
  const imgs = (r.Images && r.Images.length ? r.Images : (r.CoverUrl ? [r.CoverUrl] : []));
  if (!imgs.length) return '<div class="cover">No cover yet</div>';
  const tabs = imgs.length > 1
    ? `<div class="cdtabs">${imgs.map((u, i) => `<button type="button" class="cdtab${i ? '' : ' on'}" data-src="${esc(u)}">${esc(imageLabel(r, i))}</button>`).join('')}</div>`
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
      <div class="meta">${esc([isMoment(r) ? 'Moment in time' : r.ReleaseType, r.ReleaseRegion ? `${r.ReleaseRegion} release` : null, chart, note, r.Label].filter(Boolean).join(' · '))}</div>
      ${r.WriteUp ? `<div class="writeup">${renderWriteUp(r.WriteUp)}</div>` : ''}
      ${listenLinks(r)}
      ${status ? `<div class="badges">${status}</div>` : ''}
    </div>
  </article>`;
}

// Listen links search each service for "band title" (no accounts or keys needed)
// "Other" rows that are moments rather than records (a first gig, the day a band formed) get no listen links
const isMoment = r => r.ReleaseType === 'Other' && /\b(gig|got together|formed|first show|birthday|anniversary)\b/i.test(r.Title || '');
function listenLinks(r) {
  if (isMoment(r)) return '';
  // Filled in by fillListenLinks() with direct Apple Music / Deezer pages; hidden if we don't have a confirmed link
  return `<div class="listen" data-rid="${r.ReleaseId}" hidden></div>`;
}

// Direct "Listen" links: fetched in batches for whatever release cards are on screen
const linkCache = {};
let linkTimer = null;
async function fillListenLinks() {
  const els = [...document.querySelectorAll('.listen[data-rid]:not([data-done])')];
  if (!els.length) return;
  els.forEach(e => e.dataset.done = '1');
  const need = [...new Set(els.map(e => e.dataset.rid).filter(id => !(id in linkCache)))];
  for (let i = 0; i < need.length; i += 200) {
    try {
      const { links } = await api('links?ids=' + need.slice(i, i + 200).join(','));
      need.slice(i, i + 200).forEach(id => { linkCache[id] = links[id] || null; });
    } catch { need.slice(i, i + 200).forEach(id => { linkCache[id] = null; }); }
  }
  for (const e of els) {
    const l = linkCache[e.dataset.rid];
    const a = l && [l.apple && `<a href="${esc(l.apple)}" target="_blank" rel="noopener">Apple Music</a>`,
      l.deezer && `<a href="${esc(l.deezer)}" target="_blank" rel="noopener">Deezer</a>`].filter(Boolean);
    if (a && a.length) { e.innerHTML = `<span>Listen:</span> ${a.join(' ')}`; e.hidden = false; }
  }
}
new MutationObserver(() => { clearTimeout(linkTimer); linkTimer = setTimeout(fillListenLinks, 60); })
  .observe(document.body, { childList: true, subtree: true });

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

// Day page shows the start of a gig write-up; the full story is on the gig's own page
const SHORT = 200;
function shortText(t) {
  t = String(t);
  if (t.length <= SHORT) return t;
  const cut = t.slice(0, SHORT).replace(/\s+\S*$/, '');
  return cut.replace(/[\s,.;:!-]+$/, '') + '…';
}
function gigCard(g) {
  return `<div class="gig" data-gig="${g.GigId}" role="link" tabindex="0">
    ${g.ImageUrl ? `<img src="${esc(g.ImageUrl)}" alt="${esc(`From the night: ${g.Bands || 'gig'}${g.Venue ? ' at ' + g.Venue : ''}, ${g.GigYear}`)}" loading="lazy">` : ''}
    <div><div class="year">Gig memory · ${esc(g.GigYear)}${g.ImageCount > 1 ? ` · 📷 ${g.ImageCount} photos` : ''}</div>
      <strong>${esc(g.Bands || '')}</strong>${g.Venue ? ` at <button class="bandlink" data-venue="${esc(g.Venue)}">${esc(g.Venue)}</button>` : ''}
      ${g.TourName ? `<div class="meta">${esc(g.TourName)}</div>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(shortText(g.WriteUp))}${g.WriteUp.length > SHORT ? ' <span class="more">Read more ›</span>' : ''}</div>` : ''}
      ${g.PlaylistUrl ? `<p class="gplay"><a href="${esc(g.PlaylistUrl)}" target="_blank" rel="noopener">🎧 Listen to the setlist on Deezer</a></p>` : ''}</div>
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
  const draw = () => { box.innerHTML = `<img src="${esc(list[i])}" alt="Photo ${i + 1} of ${list.length}">${list.length > 1 ? `<button class="lbp" aria-label="Previous">‹</button><button class="lbn2" aria-label="Next">›</button><span class="lbc">${i + 1} / ${list.length}</span>` : ''}<button class="lbclose" aria-label="Close">✕</button>`; };
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
