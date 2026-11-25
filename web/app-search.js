// Gigs in toon front end, part 4 of 5: Band search, the Hide gigs / Oldest first / Covers only toggles, keyboard and menu buttons.
// The five app*.js files share one global scope and load in order (index.html): core, pages, games, search, then app.js.
// Search
let searchTimer, allBandsP;
// Visitors: the whole band list comes once (ready-made, no database) and is searched in the browser.
// Micky (signed in) still searches live so he sees bands with unposted releases too.
const fold = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
async function findBands(q) {
  if (isAdmin && !asVisitor) return (await api('search?q=' + encodeURIComponent(q))).bands;
  if (!allBandsP) allBandsP = api('search?all=1').then(r => r.bands).catch(e => { allBandsP = null; throw e; });
  const list = await allBandsP, f = fold(q);
  return list.filter(b => fold(b.Name).includes(f))
    .sort((x, y) => (fold(y.Name).startsWith(f) - fold(x.Name).startsWith(f)) || x.Name.localeCompare(y.Name)).slice(0, 50);
}
$('searchBox').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('searchBox').value.trim();
  if (q.length < 2) { $('searchResults').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const bands = await findBands(q);
      $('searchResults').innerHTML = bands.length
        ? bands.map(b => `<button type="button" data-band="${b.BandId}"><span>${esc(b.Name)}</span><span class="muted">${b.ReleaseCount}</span></button>`).join('')
        : '<p class="muted" style="padding:9px 12px;margin:0">No bands found</p>';
      $('searchResults').hidden = false;
    } catch (e) { /* ignore while typing */ }
  }, 250);
});
$('searchForm').addEventListener('submit', e => { e.preventDefault(); const b = $('searchResults').querySelector('button'); if (b) b.click(); });
document.addEventListener('click', e => {
  if (e.target.closest('.gplay a')) return;   // the Deezer link on a gig card opens Deezer, not the gig
  const tab = e.target.closest('.cdtab');
  if (tab) {
    const cover = tab.closest('.cover');
    cover.querySelector('img').src = tab.dataset.src;
    cover.querySelectorAll('.cdtab').forEach(t => t.classList.toggle('on', t === tab));
    return;
  }
  const pk = document.body.classList.contains('coversonly') && e.target.closest('#releases .card .cover');
  if (pk) { const c = pk.closest('.card'); const was = c.classList.contains('peek'); document.querySelectorAll('#releases .card.peek').forEach(x => x.classList.remove('peek')); c.classList.toggle('peek', !was); return; }
  const wu = e.target.closest('.writeup');
  if (wu && wu.closest('.card') && !e.target.closest('[data-band]')) { wu.closest('.card').classList.toggle('open'); return; }
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

// "Hide gigs" for visitors who only want the releases (remembered on this browser)
function gigsHidden() { try { return localStorage.getItem('hideGigs') === '1'; } catch { return false; } }
function setGigToggle(nGigs) {
  const hide = gigsHidden();
  document.body.classList.toggle('nogigs', hide);
  const b = document.getElementById('gigToggle');
  if (!b) return;
  b.textContent = hide ? `🎟️ Show gigs (${nGigs})` : '🎟️ Hide gigs';
  b.setAttribute('aria-pressed', String(hide));
  b.onclick = () => { try { localStorage.setItem('hideGigs', hide ? '0' : '1'); } catch { /* private mode */ } setGigToggle(nGigs); };
}

// Newest first (default) or oldest first, for the day's releases and gigs
let orderOld = (() => { try { return localStorage.getItem('oldestFirst') === '1'; } catch { return false; } })();
function oldestFirst() { return orderOld; }
function setOrderToggle() {
  const old = oldestFirst();
  const b = document.getElementById('orderToggle');
  if (!b) return;
  b.textContent = old ? '⬇️ Newest first' : '⬆️ Oldest first';
  b.setAttribute('aria-label', old ? 'Showing oldest first. Switch to newest first' : 'Showing newest first. Switch to oldest first');
  b.onclick = () => { orderOld = !old; try { localStorage.setItem('oldestFirst', orderOld ? '1' : '0'); } catch { /* private mode */ } if (current) showDay(current); };
}

// "Covers only": just the artwork; tap a cover to see its details
function coversOnly() { try { return localStorage.getItem('coversOnly') === '1'; } catch { return false; } }
function setCoverToggle() {
  const on = coversOnly();
  document.body.classList.toggle('coversonly', on);
  const b = document.getElementById('coverToggle');
  if (!b) return;
  b.textContent = on ? '🖼️ Show details' : '🖼️ Covers only';
  b.setAttribute('aria-pressed', String(on));
  document.querySelectorAll('#releases .card .cover').forEach(c => { if (on) { c.tabIndex = 0; c.setAttribute('role', 'button'); c.setAttribute('aria-label', 'Show details'); } else { c.removeAttribute('tabindex'); c.removeAttribute('role'); c.removeAttribute('aria-label'); } });
  b.onclick = () => { try { localStorage.setItem('coversOnly', on ? '0' : '1'); } catch { /* private mode */ } document.querySelectorAll('.card.peek').forEach(c => c.classList.remove('peek')); setCoverToggle(); };
}

// Keyboard: Enter/Space on anything acting as a link or button (gig cards, covers in Covers only)
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[role="link"],[role="button"]');
  if (el && el === e.target && el.tagName !== 'BUTTON' && el.tagName !== 'A') { e.preventDefault(); el.click(); }
});

// Day navigation
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
$('prevDay').onclick = () => showDay(addDays(current, -1));
$('nextDay').onclick = () => showDay(addDays(current, 1));
$('todayBtn').onclick = () => showDay(ukToday());
$('datePick').onchange = () => { const v = $('datePick').value; if (v) showDay(new Date(v + 'T00:00:00Z')); };
$('backBtn').onclick = goBack;
document.querySelectorAll('[data-back]').forEach(b => { b.onclick = goBack; });
{ const yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear(); }
$('navDay').onclick = e => { e.preventDefault(); showDay(current); };
$('navFav').onclick = e => { e.preventDefault(); showFavourites(); };
// Years page hidden from the menu for now (to-do: streamline it); ?page=years still works
$('navStats').onclick = e => { e.preventDefault(); showStats(); };
$('navWeek').onclick = e => { e.preventDefault(); showWeek(); };
$('navGuess').onclick = e => { e.preventDefault(); showGuess(); };
