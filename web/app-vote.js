// Gigs in toon front end: Vote of the week (?page=vote). Loaded after app-search.js, before app.js.
// Four randomly selected albums, singles or EPs from one year. Open Monday to Saturday 6pm; results until the next Monday.
// Hidden until switched on: the API only answers the owner until then.
const VOTE_WORD = { Album: ['album', 'albums'], Single: ['single', 'singles'], EP: ['EP', 'EPs'] };
let voteData = null, votePick = null, voteOpen = null;
function voteToken() { try { return localStorage.getItem('voteToken') || ''; } catch { return ''; } }
function saveVoteToken(t) { try { localStorage.setItem('voteToken', t); } catch { /* ignore */ } }

function timeLeft(ms) {
  if (ms <= 0) return 'Closed';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ${h % 24} hr${h % 24 === 1 ? '' : 's'} left`;
  if (h >= 1) return `${h} hr${h === 1 ? '' : 's'} left`;
  return `${Math.max(1, Math.floor(ms / 60000))} mins left`;
}
const voteDate = r => `${r.ReleaseDay} ${MONTHS[r.ReleaseMonth - 1].slice(0, 3)} ${r.ReleaseYear}`;

async function showVote() {
  showOnly('voteView');
  nav('/?page=vote');
  $('voteBody').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const t = voteToken();
    const r = await fetch('/api/vote' + (t ? '?token=' + encodeURIComponent(t) : ''), { headers: { Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Not available');
    voteData = d; saveVoteToken(d.token);
    votePick = d.voted; voteOpen = null;
    handles = d.handles || {};
    const w = VOTE_WORD[d.type] || ['release', 'releases'];
    setMeta(`Vote: ${w[1][0].toUpperCase() + w[1].slice(1)} of ${d.year}`, `Vote for your favourite of four randomly selected ${w[1]} from ${d.year}, from the Gigs in toon collection. New vote every Monday.`);
    drawVote();
    loadPastVotes();
  } catch (e) {
    $('voteBody').innerHTML = `<p class="muted">The vote isn't available right now. ${esc(e.message)}</p>`;
  }
}

function drawVote() {
  const d = voteData, w = VOTE_WORD[d.type] || ['release', 'releases'];
  const left = Date.parse(d.closesAt) - Date.parse(d.serverNow);
  const byId = Object.fromEntries(d.entries.map(x => [x.ReleaseId, x]));
  const owner = isAdmin && !asVisitor && !d.live ? '<p class="votehidden">Only you can see this page – it isn\'t live yet.</p>' : '';
  let html = `${owner}<div class="votekicker">VOTE OF THE WEEK · WEEK ${d.weekNo}</div>
    <h1 class="votetitle">${esc(w[1][0].toUpperCase() + w[1].slice(1))} of ${d.year}</h1>`;

  if (d.open && d.voted == null) {
    html += `<p class="voteintro">Four randomly selected ${esc(w[1])} from my collection, all released in ${d.year}. Which one's your favourite?</p>
      <div class="votechips"><span>${esc(timeLeft(left))}</span><span>Closes Sat 6pm</span></div>
      <div class="votegrid">${d.entries.map(x => voteCard(x, w)).join('')}</div>
      <div class="votego">${votePick ? `<button id="voteSend" class="votebtn">Vote for ${esc(byId[votePick].Title)}</button>`
        : '<div class="votehint">Tap a cover to pick your favourite</div>'}
      <p class="muted small">One vote each. You'll see how the vote is going once you've voted.</p></div>`;
  } else {
    const mine = d.voted != null ? byId[d.voted] : null;
    if (!d.open && d.winners && d.winners.length) {
      const win = d.winners.map(id => byId[id]);
      const top = d.results[0];
      html += `<h2 class="voteh">${win.length > 1 ? "It's a tie!" : 'And the winner is…'}</h2>
        <div class="votewinners">${win.map(x => `<div class="votewin"><img src="${esc(x.CoverUrl)}" alt="Cover of ${esc(x.Title)} by ${esc(x.Artist)}">
          <div class="body"><div class="t">🏆 ${esc(x.Title)}</div><div class="a">${esc(x.Artist)} · ${esc(voteDate(x))}${x.ChartPosition ? ' · UK No ' + x.ChartPosition : ''}</div>
          <div><strong>${top.pct}%</strong> of ${d.total} vote${d.total === 1 ? '' : 's'}</div></div></div>`).join('')}</div>`;
    } else if (!d.open) {
      html += '<p class="voteintro">Voting has closed – nobody voted this week.</p>';
    } else {
      html += `<div class="votethanks">${mine ? `<img src="${esc(mine.CoverUrl)}" alt="">` : ''}<div><div class="t">Thanks – your vote's in!</div>
        ${mine ? `<div class="muted">You picked ${esc(mine.Title)} by ${esc(mine.Artist)}</div>` : ''}</div></div>
        ${d.message ? `<p class="votehidden">${esc(d.message)}</p>` : ''}`;
    }
    if (d.results) {
      html += `<div class="voteresh"><h2 class="voteh">${d.open ? "How it's going" : 'Final standings'}</h2><span class="muted small">${d.total} vote${d.total === 1 ? '' : 's'}${d.open ? ' so far' : ''}</span></div>
        <div class="votebars">${d.results.map((r, i) => { const x = byId[r.id]; const me = r.id === d.voted; const lead = !d.open && d.winners && d.winners.includes(r.id);
          return `<div class="votebar"><img src="${esc(x.CoverUrl)}" alt=""><div class="b"><div class="l"><span>${esc(x.Title)}${me ? ' <em>· your vote</em>' : ''}</span><span>${r.pct}%</span></div>
          <div class="track"><i style="width:${r.pct}%" class="${me || lead ? 'mine' : ''}"></i></div></div></div>`; }).join('')}</div>
        <p class="muted small">${d.open ? 'The winner is announced on Saturday at 6pm.' : 'A new vote opens on Monday – it could be albums, singles or EPs from any year.'}</p>`;
    }
    if (d.open) html += `<div class="voteshare"><div class="t">Get your mates voting</div><div class="row">
      <a href="https://x.com/intent/post?text=${encodeURIComponent(`I've voted in this week's Gigs in toon vote – ${w[1]} of ${d.year}. Pick yours 👉 https://www.gigsintoon.co.uk/?page=vote`)}" target="_blank" rel="noopener">X</a>
      <a href="https://bsky.app/intent/compose?text=${encodeURIComponent(`I've voted in this week's Gigs in toon vote – ${w[1]} of ${d.year}. Pick yours 👉 https://www.gigsintoon.co.uk/?page=vote`)}" target="_blank" rel="noopener">Bluesky</a>
      <button type="button" id="voteCopy">Copy link</button></div></div>`;
  }
  html += `<div class="votehow"><div class="t">How it works</div>
    <p>Every Monday the site randomly picks a year and whether it's albums, singles or EPs, then four randomly selected releases of that type from that year in my collection.</p>
    <p>The winner's announced on Saturday and added to the past votes below.</p></div>
    <div id="votePast"></div>`;
  $('voteBody').innerHTML = html;
}

function voteCard(x, w) {
  const sel = votePick === x.ReleaseId, open = voteOpen === x.ReleaseId;
  const md = `${ordinal(x.ReleaseDay)} ${MONTHS[x.ReleaseMonth - 1]}`;
  return `<div class="votecard${sel ? ' sel' : ''}${open ? ' open' : ''}">
    <button type="button" class="votepick" data-vpick="${x.ReleaseId}" aria-pressed="${sel}" aria-label="Pick ${esc(x.Title)} by ${esc(x.Artist)}">
      <span class="vc"><img src="${esc(x.CoverUrl)}" alt="Cover of ${esc(x.Title)} by ${esc(x.Artist)}" loading="lazy">${sel ? '<span class="tick">✓</span>' : ''}</span>
      <span class="vt">${esc(x.Title)}</span><span class="va">${esc(x.Artist)}</span>
      <span class="vm">${esc(voteDate(x))}${x.ChartPosition ? ' · UK No ' + x.ChartPosition : ''}</span>
    </button>
    <button type="button" class="voteinfo" data-vinfo="${x.ReleaseId}" aria-expanded="${open}">${open ? `Hide ${esc(w[0])} info ▴` : `About this ${esc(w[0])} ▾`}</button>
    ${open ? `<div class="votemore">
      ${x.WriteUp ? `<div class="lbl">IN MY WORDS</div><div class="writeup">${renderWriteUp(x.WriteUp)}</div>` : ''}
      <div class="listen" data-rid="${x.ReleaseId}" hidden></div>
      <button type="button" class="votebtn" data-vpick="${x.ReleaseId}">Pick ${esc(x.Title)}</button>
      <a href="/?date=${String(x.ReleaseMonth).padStart(2, '0')}-${String(x.ReleaseDay).padStart(2, '0')}">Everything released on ${esc(md)} ›</a>
    </div>` : ''}
  </div>`;
}

async function loadPastVotes() {
  try {
    const r = await fetch('/api/vote?past=1', { headers: { Accept: 'application/json' } });
    const { past } = await r.json();
    if (!past || !past.length || !$('votePast')) return;
    $('votePast').innerHTML = `<h2 class="voteh">Past winners</h2>` + past.map(p => {
      const by = Object.fromEntries(p.entries.map(x => [x.ReleaseId, x]));
      const win = p.winners.map(id => by[id]).filter(Boolean);
      const rest = p.entries.filter(x => !p.winners.includes(x.ReleaseId)).map(x => x.Title);
      const w = VOTE_WORD[p.type] || ['release', 'releases'];
      return `<div class="votepast">${win[0] ? `<img src="${esc(win[0].CoverUrl)}" alt="">` : ''}<div>
        <div class="muted small">Week ${p.weekNo} · ${esc(w[1][0].toUpperCase() + w[1].slice(1))} of ${p.year}</div>
        <div class="t">${win.map(x => esc(x.Title)).join(' & ')}</div>
        <div class="small">${esc(win.map(x => x.Artist).join(' & '))}${rest.length ? ' · beat ' + esc(rest.join(', ')) : ''}</div></div></div>`;
    }).join('');
  } catch { /* past winners are optional */ }
}

document.addEventListener('click', async e => {
  if (!voteData || $('voteView').hidden) return;
  const pick = e.target.closest('[data-vpick]'), info = e.target.closest('[data-vinfo]');
  if (pick && voteData.open && voteData.voted == null) { votePick = Number(pick.dataset.vpick); drawVote(); loadPastVotes(); return; }
  if (info) { const id = Number(info.dataset.vinfo); voteOpen = voteOpen === id ? null : id; drawVote(); loadPastVotes(); return; }
  if (e.target.id === 'voteCopy') {
    try { await navigator.clipboard.writeText('https://www.gigsintoon.co.uk/?page=vote'); e.target.textContent = 'Copied ✓'; } catch { /* ignore */ }
    return;
  }
  if (e.target.id === 'voteSend' && votePick) {
    e.target.disabled = true; e.target.textContent = 'Sending…';
    try {
      const r = await fetch('/api/vote', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: votePick, token: voteToken() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Your vote could not be sent.');
      voteData = d; saveVoteToken(d.token); countClick('vote');
      drawVote(); loadPastVotes(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      e.target.disabled = false; e.target.textContent = 'Try again';
      const p = e.target.parentNode.querySelector('.voteerr') || e.target.insertAdjacentElement('afterend', Object.assign(document.createElement('p'), { className: 'voteerr' }));
      p.textContent = err.message;
    }
  }
});
