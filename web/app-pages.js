// Gigs in toon front end, part 2 of 5: Page addresses and Back, page titles, and the day, band, gig, year, venue, week and stats pages.
// The five app*.js files share one global scope and load in order (index.html): core, pages, games, search, then app.js.
// Page addresses and the browser's Back button. Moving to another page adds a history step (so Back returns
// to where you were); stepping day to day just updates the address. While a page is drawn because of a
// load, Back or Forward, the address is only replaced.
let routing = false;
function nav(url) {
  const cur = location.pathname + location.search;
  if (url === cur) return;
  const kind = u => (u.match(/^\/\?(\w+)/) || [])[1] || '';
  if (routing || (kind(url) === 'date' && kind(cur) === 'date')) history.replaceState(history.state, '', url);
  else history.pushState({ n: ((history.state && history.state.n) || 0) + 1 }, '', url);
}
function routeNow() { routing = true; try { route(); } finally { routing = false; } }

// Each view gets its own title, description and canonical address, so search engines list the
// day, band, gig and year pages separately (before 25 Nov 2026 every page said it was a copy of the home page).
// Someone landing on the bare home page keeps the home page's own title and canonical.
let homeLanding = location.pathname === '/' && !location.search;
function setMeta(title, desc) {
  const home = homeLanding; homeLanding = false;
  document.title = title && !home ? `${title} – Gigs in toon` : 'Gigs in toon – On This Day';
  const d = document.querySelector('meta[name="description"]');
  if (d && desc && !home) d.setAttribute('content', desc);
  const c = document.querySelector('link[rel="canonical"]');
  if (c) c.setAttribute('href', 'https://www.gigsintoon.co.uk' + (home ? '/' : location.pathname + location.search));
}
window.addEventListener('popstate', routeNow);
// In-page "Back": a step back within the site if there is one, otherwise today's page
function goBack() { if (history.state && history.state.n > 0) history.back(); else { routing = false; showDay(ukToday()); } }

async function showGig(id) {
  showOnly('gigView');
  nav(`/?gig=${id}`);
  $('gigBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { gig: g } = await api(`gigs/${id}`);
    const d = new Date(g.GigDate);
    const when = `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const bill = g.Bands.map(b => `<button class="bandlink" data-band="${b.BandId}">${esc(b.Name)}</button>`).join(' + ');
    const pics = g.Images.map((i, n) => `<figure><button class="pic" data-pic="${n}" aria-label="View larger"><img src="${esc(i.Url)}" alt="${esc(i.AltText || i.Kind)}" loading="lazy"></button>
      ${isAdmin && !asVisitor ? `<button class="ghost picx" data-picx="${esc(i.Url)}" title="Remove this photo">✕</button>` : ''}</figure>`).join('');
    window.__gigPics = g.Images.map(i => i.Url);
    const names = g.Bands.map(b => b.Name);
    setMeta(`${names.join(' + ')} at ${g.Venue}, ${when}`,
      `Gig memory: ${names.join(' + ')} at ${[g.Venue, g.City].filter(Boolean).join(', ')} on ${when}${g.TourName ? ` (${g.TourName})` : ''} – photos, setlist and memories.`);
    const sets = (g.Setlist || []).map(s => `<div class="set"><h3>${esc(s.band)}</h3><ol>${(s.songs || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>`).join('');
    $('gigBody').innerHTML = `
      <div class="year">Gig memory · ${esc(when)}</div>
      <h1>${bill}</h1>
      <p class="muted">${esc([g.Venue, g.City].filter(Boolean).join(', '))}${g.TourName ? ` · ${esc(g.TourName)}` : ''}</p>
      ${g.PlaylistUrl ? `<p><a class="btn" href="${esc(g.PlaylistUrl)}" target="_blank" rel="noopener">▶ Listen to the setlist on Deezer</a></p>` : ''}
      ${pics ? `<div class="gigpics${g.Images.length > 1 ? ' many' : ''}">${pics}</div>` : ''}
      ${isAdmin && !asVisitor ? `<p><label class="btn addpics">📷 Add photos<input id="addPics" type="file" accept="image/*" multiple hidden></label> <span id="picMsg" class="muted"></span></p>` : ''}
      ${g.WriteUp ? `<div class="writeup">${renderWriteUp(g.WriteUp)}</div>` : ''}
      ${isAdmin && !asVisitor ? `<p><button class="btn ghost" id="editWu">✏️ Edit write-up</button></p>
        <div id="wuBox" hidden><textarea id="wuText" rows="7" style="width:100%;font:inherit;padding:10px;border-radius:8px;background:var(--panel);color:var(--text);border:1px solid var(--line)"></textarea>
        <p><button class="btn" id="wuSave">Save</button> <button class="btn ghost" id="wuCancel">Cancel</button> <span id="wuMsg" class="muted"></span></p></div>` : ''}
      ${(g.Videos || []).length ? `<h2>Video${g.Videos.length > 1 ? 's' : ''} from the night</h2><div class="gigvids">${g.Videos.map(v => `<figure><div class="yt"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}" title="${esc(v.title || 'Video')}" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>${v.title ? `<figcaption>${esc(v.title)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      ${sets ? `<h2>Setlist</h2><div class="sets">${sets}</div>` : ''}
      ${g.SetlistUrl && sets ? `<p class="meta">Setlist from <a href="${esc(g.SetlistUrl)}" target="_blank" rel="noopener">setlist.fm</a></p>` : ''}`;
    $('addPics')?.addEventListener('change', e => addGigPhotos(g, [...e.target.files]));
    // Owner: edit the write-up in place (saved straight away; the gig's day is rebuilt so visitors see it)
    $('editWu')?.addEventListener('click', () => { $('wuText').value = g.WriteUp || ''; $('wuBox').hidden = false; $('editWu').hidden = true; $('wuText').focus(); });
    $('wuCancel')?.addEventListener('click', () => { $('wuBox').hidden = true; $('editWu').hidden = false; });
    $('wuSave')?.addEventListener('click', async () => {
      $('wuMsg').textContent = 'Saving…';
      try {
        const r = await (await fetch('/api/manage/gig', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: g.GigId, date: g.GigDate.slice(0, 10), bands: g.Bands.map(b => b.Name),
                                 status: g.Status, writeUp: $('wuText').value.trim() }) })).json();
        if (!r.ok) throw new Error(r.error || 'Could not save');
        showGig(g.GigId);
      } catch (e) { $('wuMsg').textContent = e.message; }
    });
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
  for (const v of ['dayView', 'bandView', 'favView', 'gigView', 'yearView', 'statsView', 'guessView', 'venueView', 'weekView', 'surpriseView', 'voteView']) $(v).hidden = v !== id;
  document.querySelectorAll('.nav a[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === id));
}

// Days with nothing on them get something fun instead of a blank page
const EMPTY_JOKES = [
  ['Why did the drummer get a job at the bakery?', 'He was great at rolls. 🥁'],
  ['How do you make a bandstand?', 'Take away their chairs. 🪑'],
  ['What do you call a guitarist who only knows two chords?', 'A music critic. 🎸'],
  ['Why did the singer climb a ladder?', 'To reach the high notes. 🎤'],
  ['What\'s the difference between a bassist and a pizza?', 'A pizza can feed a family of four. 🍕'],
  ['How many guitarists does it take to change a lightbulb?', 'Five. One to change it, four to say they could have done it better. 💡'],
  ['Why couldn\'t the band find their drummer?', 'He was still in the Green Room, counting to four. ⏱️'],
  ['What\'s a skeleton\'s favourite instrument?', 'The trom-bone. 💀'],
  ['Why did the pop punk band cross the road?', 'Because it was all the small things. 🛣️'],
  ['What do you call a cow that plays guitar?', 'A moo-sician. 🐄'],
  ['Why do bands never play hide and seek?', 'Because good luck hiding from the sound engineer. 🔊'],
  ['What kind of music are balloons scared of?', 'Pop. 🎈'],
  ['How do you fix a broken tuba?', 'With a tuba glue. 🎺'],
  ['What did the Britpop fan say at the checkout?', '"Do you have any Blur-ry receipts?" (We\'re sorry.) 🧾'],
  ['Why was the setlist so calm?', 'It knew the encore was coming. 🙌']
];
function pickJoke(not) {
  let i = Math.floor(Math.random() * EMPTY_JOKES.length);
  if (String(i) === String(not)) i = (i + 1) % EMPTY_JOKES.length;
  const [q, a] = EMPTY_JOKES[i];
  const p = document.getElementById('emptyJoke'); if (p) p.dataset.i = i;
  return `<strong>${esc(q)}</strong><br>${esc(a)}`;
}
function emptyDayCard(m, d) {
  if (m === 12 && (d === 24 || d === 25)) {
    return `<div class="card emptyfun xmas"><div class="emptyemoji">🎄</div>
      <h3>${d === 24 ? 'It\'s Christmas Eve!' : 'Merry Christmas!'}</h3>
      <p>Even the bands take Christmas off – nothing was released on this day.</p>
      <p>Put the kettle on, grab a mince pie and stick on your favourite festive tune. 🎅🎶</p>
      <p><button id="emptySurprise" type="button">🎁 Unwrap a random release</button></p></div>`;
  }
  const i = Math.floor(Math.random() * EMPTY_JOKES.length);
  const [q, a] = EMPTY_JOKES[i];
  return `<div class="card emptyfun"><div class="emptyemoji">🦗</div>
    <h3>Nothing released on this day… yet!</h3>
    <p>So here's a terrible music joke instead:</p>
    <p id="emptyJoke" class="joke" data-i="${i}"><strong>${esc(q)}</strong><br>${esc(a)}</p>
    <p><button id="emptyAnother" type="button" class="ghost">😂 Another one</button> <button id="emptySurprise" type="button">🎲 Surprise me</button></p>
    <p class="muted">Know something that came out on this day? <a href="/contact">Let me know</a>.</p></div>`;
}

async function showDay(date) {
  current = date;
  const m = date.getUTCMonth() + 1, d = date.getUTCDate();
  showOnly('dayView');
  $('dayTitle').textContent = `${ordinal(d)} ${MONTHS[m - 1]}`;
  $('datePick').value = date.toISOString().slice(0, 10);
  $('daySummary').textContent = 'Loading…';
  $('releases').innerHTML = ''; $('gigs').innerHTML = '';
  nav(`/?date=${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  try {
    const data = await api(`onthisday?month=${m}&day=${d}`);
    handles = data.handles || {};
    if (oldestFirst()) {   // the API gives newest first; flip by year (bands A–Z within a year stay as they are)
      data.releases = data.releases.map((r, i) => [r, i]).sort((a, b) => (a[0].ReleaseYear - b[0].ReleaseYear) || (a[1] - b[1])).map(x => x[0]);
      data.gigs = [...data.gigs].sort((a, b) => String(a.GigDate).localeCompare(String(b.GigDate)));
    }
    const n = data.releases.length;
    const today = ukToday();
    const viewYear = today.getUTCFullYear();
    const isToday = m === today.getUTCMonth() + 1 && d === today.getUTCDate();
    const nNew = data.releases.filter(r => r.ReleaseYear === viewYear).length;
    const label = `${ordinal(d)} ${MONTHS[m - 1]}`;
    const eg = data.releases.slice(0, 3).map(r => `${r.Title} by ${r.Artist} (${r.ReleaseYear})`);
    setMeta(`Albums and singles released on ${label}`,
      n ? `Music released on ${label}: ${n} release${n === 1 ? '' : 's'}, including ${eg.join(', ')}. Plus gig memories from the North East.`
        : `Music released on ${label}, and gig memories from the North East.`);
    $('daySummary').textContent = n
      ? `${n} release${n === 1 ? '' : 's'} on this day` + (nNew ? ` · ${nNew} new this year` : '')
      : '';
    $('gigs').innerHTML = (data.remembering || []).map(rememberCard).join('') + data.gigs.map(gigCard).join('') + (data.gigTeasers || []).map(gigTeaserCard).join('');
    const teasers = data.teasers || [];
    $('releases').innerHTML = (n ? data.releases.map(r => releaseCard(r, { viewYear, isToday })).join('') : '')
      + teasers.map(teaserCard).join('')
      || ($('gigs').innerHTML ? '<p class="empty">Nothing recorded for this day yet.</p>' : emptyDayCard(m, d));
    const emptyBtn = document.getElementById('emptySurprise');
    if (emptyBtn) emptyBtn.onclick = () => showSurprise();
    const jokeBtn = document.getElementById('emptyAnother');
    if (jokeBtn) jokeBtn.onclick = () => { const p = document.getElementById('emptyJoke'); if (p) p.innerHTML = pickJoke(p.dataset.i); };
    if (teasers.length) $('daySummary').textContent += `${n ? ' · ' : ''}${teasers.length} still to come – guess them from the clues`;
    const nGigs = data.gigs.length + (data.gigTeasers || []).length;
    $('gigToggle').hidden = !nGigs;
    setGigToggle(nGigs);
    $('coverToggle').hidden = !n;
    setCoverToggle();
    $('orderToggle').hidden = n + data.gigs.length < 2;
    setOrderToggle();
  } catch (e) {
    $('daySummary').textContent = e.message;
  }
}

async function showBand(id) {
  showOnly('bandView');
  $('bandName').textContent = 'Loading…'; $('bandReleases').innerHTML = ''; $('bandGigs').innerHTML = ''; $('bandHandles').textContent = '';
  nav(`/?band=${id}`);
  try {
    const { band, releases, gigs: bandGigs = [], handles: h } = await api(`bands/${id}`);
    handles = h || {};
    $('bandName').textContent = band.Name;
    setMeta(`${band.Name}: release dates and gigs`,
      `${band.Name} release history: ${releases.length} album${releases.length === 1 ? '' : 's'} and singles with release dates${bandGigs.length ? `, plus ${bandGigs.length} gig memor${bandGigs.length === 1 ? 'y' : 'ies'}` : ''}.`);
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
  nav(year ? `/?year=${year}` : '/?page=years');
  try {
    const { years } = await api('years');
    $('yearList').innerHTML = years.map(y => `<button type="button" class="yearbtn${String(y.year) === String(year) ? ' on' : ''}" data-year="${y.year}">${y.year}</button>`).join('');
    setMeta(year ? `Albums and singles released in ${year}` : 'Browse music by year',
      year ? `Music released in ${year}: albums and singles from my collection, with release dates, plus gigs from that year.` : 'Browse albums, singles and gig memories by year.');
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
  nav(`/?venue=${encodeURIComponent(name)}`);
  $('venueTitle').textContent = name; $('venueBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const v = await api(`venue?name=${encodeURIComponent(name)}`);
    $('venueTitle').textContent = v.venue;
    setMeta(`Gigs at ${v.venue}`, `Gig memories from ${v.venue}${v.city ? ', ' + v.city : ''}: ${v.gigs.length} gig${v.gigs.length === 1 ? '' : 's'} with photos and setlists.`);
    $('venueBody').innerHTML = `<p class="muted">${v.gigs.length} gig${v.gigs.length === 1 ? '' : 's'}${v.city ? ' · ' + esc(v.city) : ''} · still adding more</p>`
      + (v.gigs.map(gigCardDated).join('') || '<p class="empty">No gigs here yet.</p>');
  } catch (e) { $('venueBody').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// This week: the next seven days at a glance
async function showWeek() {
  showOnly('weekView');
  nav('/?page=week');
  setMeta('This week in music history', 'Albums and singles released this week in years gone by, day by day, plus gig memories.');
  $('weekBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { days } = await api('week');
    $('weekBody').innerHTML = days.map((x, i) => {
      const d = new Date(ukToday().getTime() + i * 86400000);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const thumbs = x.thumbs.map(t => `<img${t.tz ? ' class="tz"' : ''} src="${esc(t.u)}" alt="${esc(t.t)}" title="${esc(t.t)}" width="64" height="64" loading="lazy" decoding="async">`).join('');
      const mmdd = `${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}`;
      return `<a class="weekday" href="/?date=${mmdd}" data-date="${mmdd}">
        <div class="wd"><b>${label}</b><span>${ordinal(x.day)} ${MONTHS[x.month - 1]}</span></div>
        <div class="wn">${x.releases} release${x.releases === 1 ? '' : 's'}${x.gigs ? ` · ${x.gigs} gig memor${x.gigs === 1 ? 'y' : 'ies'}` : ''}</div>
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
  nav('/?page=stats');
  setMeta('Stats', 'Numbers from a lifetime of music: releases, bands, years and gigs.');
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
