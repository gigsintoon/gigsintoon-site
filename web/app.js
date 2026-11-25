// Gigs in toon front end, part 5 of 5: Surprise me, admin bar, routing, visit counting, countdown and start-up (loaded last).
// The five app*.js files share one global scope and load in order (index.html): core, pages, games, search, then app.js.
// Surprise me: a page showing just the one random release, so it's clear what the surprise is
async function showSurprise() {
  showOnly('surpriseView');
  setMeta('Surprise me', 'A random release from a lifetime of music – press again for another.');
  $('surpriseBody').innerHTML = '<p class="muted">Picking something…</p>';
  $('surpriseDay').hidden = true;
  try {
    // Remember what this visitor has already been shown (on their own device only) and skip repeats
    let seen = []; try { seen = JSON.parse(localStorage.getItem('surpriseSeen') || '[]'); } catch {}
    let r = await api('random');
    for (let i = 0; i < 10 && r.ReleaseId && seen.includes(r.ReleaseId); i++) r = await api('random');
    if (r.ReleaseId) { seen.push(r.ReleaseId); try { localStorage.setItem('surpriseSeen', JSON.stringify(seen.slice(-1500))); } catch {} }
    if (!r.Month) { $('surpriseBody').innerHTML = '<p class="empty">Nothing to pick from yet.</p>'; return; }
    nav('/?page=surprise');
    const data = await api(`onthisday?month=${r.Month}&day=${r.Day}`);
    handles = data.handles || {};
    const rel = data.releases.find(x => x.ReleaseId === r.ReleaseId);
    if (!rel) { $('surpriseBody').innerHTML = '<p class="empty">Could not load that one – try again.</p>'; return; }
    $('surpriseBody').innerHTML = `<div class="surprise">${releaseCard(rel, { showDate: true })}</div>`;
    const date = new Date(Date.UTC(ukToday().getUTCFullYear(), r.Month - 1, r.Day));
    $('surpriseDay').textContent = `See everything from ${ordinal(r.Day)} ${MONTHS[r.Month - 1]}`;
    $('surpriseDay').hidden = false;
    $('surpriseDay').onclick = () => showDay(date);
  } catch (e) { $('surpriseBody').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
$('surpriseBtn').onclick = () => { countClick('surprise'); showSurprise(); };
$('surpriseAgain').onclick = () => { countClick('surprise'); showSurprise(); };

// Admin bits in the header: link to the list page, and "view as visitor"
function renderAdminBar() {
  $('adminBar').hidden = !isAdmin;
  $('signIn').hidden = isAdmin;
  if (!isAdmin) return;
  $('adminBar').innerHTML = window.adminBarHtml(`<button id="visitorToggle" type="button" class="ghost">${asVisitor ? 'Viewing as visitor – switch back' : 'View as visitor'}</button>`);
  $('visitorToggle').onclick = () => { asVisitor = !asVisitor; sessionStorageSet('asVisitor', asVisitor ? '1' : '0'); renderAdminBar(); routeNow(); };
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
  else if (p.get('page') === 'surprise') showSurprise();
  else if (/^\d{2}-\d{2}$/.test(p.get('date') || '')) {
    const [mm, dd] = p.get('date').split('-').map(Number);
    showDay(new Date(Date.UTC(ukToday().getUTCFullYear(), mm - 1, dd)));
  } else showDay(ukToday());
}

// Count the visit (no cookies, nothing personal – see /privacy)
// Count a button press (shown on the visitors page; not counted as a page view)
function countClick(name) {
  try { fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ click: name }) }); } catch { /* ignore */ }
}
function countVisit(as) {
  try {
    // Arriving through a short link from a post (/day/11-24, /gig/150, /band/701): that page hands on the address
    // clicked and the site the visitor came from (X, Bluesky...), which the jump to this page would otherwise lose.
    let land = null;
    try { land = JSON.parse(sessionStorage.getItem('landing') || 'null'); sessionStorage.removeItem('landing'); } catch { land = null; }
    if (!land || !/^\/(day|gig|band)\/[\w-]{1,10}$/.test(land.p || '') || Date.now() - (land.t || 0) > 60000) land = null;
    fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ path: as || (land && land.p) || location.pathname + (location.search.startsWith('?page=') ? location.search : ''), ref: land ? land.r : document.referrer,
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '') }) });
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
  if (isAdmin) { window.__ownerView = true; document.documentElement.classList.remove('noshare'); }
  if (!launch.live && (!isAdmin || asVisitor)) { countVisit('/countdown'); showCountdown(launch.launchAt, launch.now); return; }
  countVisit();
  renderAdminBar();
  routeNow();
})();
