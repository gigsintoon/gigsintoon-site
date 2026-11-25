// Gigs in toon front end, part 3 of 5: Guess the Cover and favourite albums.
// The five app*.js files share one global scope and load in order (index.html): core, pages, games, search, then app.js.
// Guess the cover – a new one every day
const MONTH_NAMES = MONTHS;
async function showGuess() {
  showOnly('guessView');
  nav('/?page=guess');
  setMeta('Guess the Cover', 'A daily music quiz: guess the album from a blurred cover.');
  try {
    const g = await api('guess');
    const daily = window._guessDaily = !/-W\d/.test(g.week || '');            // weekly until 15 Nov 2026, daily after
    const T = daily ? { now: 'today', The: "Today's", the: "today's", last: 'Yesterday', next: 'A new cover every day at midnight – today\'s winners are announced on our socials at 11pm.' }
                    : { now: 'this week', The: "This week's", the: "this week's", last: 'Last week', next: 'A new cover every Monday.' };
    const what = TYPE_WORD[g.type] || 'a release';
    const last = g.lastWeek;   // (yesterday's, since the switch to daily)
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
        <div class="gcover"><img src="/api/teaser/${g.id}?b=${BLUR[0]}" alt="${T.The} mystery cover"></div>
        <div class="gside">
          <p class="lead">Can you name ${T.the} mystery cover? Guess the band or the title.</p>
          <ul id="clues" class="clues"><li>${CLUES[0]}</li></ul>
          <form id="guessForm" class="gform"><input name="guess" placeholder="Band or title…" autocomplete="off" maxlength="120" required>
            <button class="btn" type="submit">Guess</button></form>
          <p id="guessResult" class="muted" role="status">${g.tally.tries ? `${g.tally.correct} of ${g.tally.tries} guesses right so far ${T.now}.` : `Be the first to have a go ${T.now}!`}</p>
          <p class="muted" style="font-size:14px">Every wrong guess makes the cover a bit clearer and gives you another clue. ${T.next}</p>
          <button id="giveUp" type="button" class="ghost" hidden>I give up – show me</button>
          <div id="boardJoin"></div>
        </div>
      </div>
      <section class="board"><h2>${T.The} leaderboard</h2>
        <p class="muted" style="font-size:14px">Fewest guesses wins; time from opening the page breaks a tie. Adding your name is optional.</p>
        <div id="board">${boardHtml(g.board, g.admin)}</div></section>
      ${g.lastBoard && g.lastBoard.length ? `<p class="muted">${T.last}'s winner${g.lastBoard.length > 1 ? 's' : ''}: ${g.lastBoard.map((e, i) => `${['🥇', '🥈', '🥉'][i]} <b>${esc(e.name)}</b> (${e.guesses} guess${e.guesses === 1 ? '' : 'es'}, ${fmtTime(e.ms)})`).join(' &nbsp; ')}</p>` : ''}
      ${last && last.tally.tries ? `<h2>${T.last}'s answer</h2>
        <div class="fav"><img src="${esc(last.cover)}" alt="" loading="lazy"><div><button class="artist" data-band="${last.bandId}">${esc(last.artist)}</button>
        <div class="title">${esc(last.title)} (${last.year})</div><div class="meta">${last.tally.correct} of ${last.tally.tries} guessed it</div></div></div>` : ''}`;
    const img = document.querySelector('.gcover img');
    BLUR.slice(1).forEach(b => { const p = new Image(); p.src = `/api/teaser/${g.id}?b=${b}`; });
    const reveal = (a, text) => {
      img.src = a.cover; document.querySelector('.gcover').classList.add('revealed');
      $('guessResult').innerHTML = `${text} <b>${esc(a.artist)} – ${esc(a.title)}</b> (${a.year}). <a href="/?date=${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}">See it on its day</a>
        <p class="discover">🎧 New to you? Why not give it a listen today!</p>${a.releaseId ? `<div class="listen" data-rid="${a.releaseId}" hidden></div>` : ''}`;
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
      ${window._guessDaily ? '<p class="muted" style="font-size:13px">Today\'s winners may be shown by name on our socials (X, Bluesky, Instagram) at 11pm.</p>' : ''}
      <input name="name" placeholder="Your name" maxlength="24" autocomplete="nickname" required>
      <button class="btn" type="submit">Add me</button>
      <p id="boardMsg" class="muted" role="status"></p></form>`;
  $('boardForm').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await fetch('/api/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: true, name: e.target.name.value, win: r.win }) }).then(x => x.json());
    if (!res.ok) { $('boardMsg').textContent = res.error || 'Something went wrong.'; return; }
    $('board').innerHTML = boardHtml(res.board);
    $('boardJoin').innerHTML = `<p>🏆 You're <b>${ordinal(res.place)}</b> of ${res.of} ${window._guessDaily ? 'today' : 'this week'}!</p>`;
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
  nav(year ? `/?page=favourites&year=${year}` : '/?page=favourites');
  setMeta(year ? `Albums of the year ${year}` : 'Albums of the year', 'My favourite albums of each year, ranked.');
  $('favBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const fav = await api('favourites');
    const upcoming = fav.upcoming;
    const thisYear = new Date().getFullYear();
    const years = fav.years.filter(y => y.year <= thisYear);   // future years stay hidden until they arrive
    const pick = years.find(y => String(y.year) === String(year)) || years.find(y => y.year === 2025) || years[0];
    $('favYears').innerHTML = years.map(y =>
      `<button type="button" class="yearbtn${y === pick ? ' on' : ''}" data-favyear="${y.year}">${y.year}${y.kind === 'upcoming' ? ' (upcoming)' : ''}</button>`).join('');
    const title = pick.kind !== 'upcoming' && !pick.ranked && !/particular order/i.test(pick.title)
      ? `${pick.title} in no particular order` : pick.title;
    let html = `<h2>${esc(title)}</h2>${pick.note ? `<p class="muted">${esc(pick.note)}</p>` : ''}`;
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
  return `<ol class="favs${ranked ? ' ranked' : ''}">${list.map(a => `<li class="fav${ranked && Number(a.rank) === 1 ? ' top' : ''}">
      ${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : '<div class="nocover"></div>'}
      <div>${ranked && a.rank ? `<span class="rank">${a.rank}</span>` : ''}
        ${a.bandId ? `<button class="artist" data-band="${a.bandId}">${esc(a.artist)}</button>` : `<strong>${esc(a.artist)}</strong>`}
        <div class="title">${esc(a.title)}</div>
        ${a.note ? `<div class="meta">${esc(a.note)}</div>` : ''}</div>
    </li>`).join('')}</ol>`;
}
