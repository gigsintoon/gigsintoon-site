// Admin release list: one month at a time, coloured like the spreadsheet
const $ = (id) => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const NEXT = { none: 'orange', orange: 'green', green: 'none', red: 'none' };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function colourOf(r) {
  if (r.Status === 'DoNotPost') return 'red';
  if (r.Status === 'Posted' && r.OnSonos) return 'green';
  if (r.Status === 'Drafted' || r.Status === 'Posted') return 'orange';
  return 'none';
}

let month = (() => {
  const p = new URLSearchParams(location.search).get('m');
  if (+p >= 1 && +p <= 12) return +p;
  return +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'numeric' }).format(new Date());
})();
let rows = [];

$('months').innerHTML = MONTHS.map((m, i) =>
  `<button type="button" class="yearbtn" data-m="${i + 1}">${m.slice(0, 3)}</button>`).join('');

async function load() {
  document.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', +b.dataset.m === month));
  history.replaceState(null, '', `/admin?m=${month}`);
  $('rows').innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
  const res = await fetch(`/api/manage/month?m=${month}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { $('rows').innerHTML = `<tr><td colspan="8">${esc(body.error || res.status)}</td></tr>`; return; }
  rows = body.rows;
  render();
  pending();
}

function render() {
  const missing = $('fMissing').checked, hideRed = $('fHideRed').checked, q = $('fText').value.trim().toLowerCase();
  let lastDay = null;
  const shown = rows.filter(r => {
    if (hideRed && colourOf(r) === 'red') return false;
    if (missing && r.ImageCount && r.HasWriteUp) return false;
    if (q && !(`${r.Band} ${r.Title} ${r.ReleaseYear}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const counts = { green: 0, orange: 0, none: 0, red: 0 };
  rows.forEach(r => counts[colourOf(r)]++);
  $('counts').textContent = `${rows.length} releases · ${counts.green} green · ${counts.orange} orange · ${counts.none} not started · ${counts.red} red`;
  $('rows').innerHTML = shown.map(r => {
    const c = colourOf(r);
    const dayCell = r.ReleaseDay !== lastDay
      ? `<a href="/?date=${String(month).padStart(2, '0')}-${String(r.ReleaseDay).padStart(2, '0')}" title="Open this day">${ordinal(r.ReleaseDay)}</a>` : '';
    const start = r.ReleaseDay !== lastDay ? ' daystart' : '';
    lastDay = r.ReleaseDay;
    const chart = r.ChartPosition ? `No. ${r.ChartPosition}` : (r.ChartNote || '');
    return `<tr class="r c-${c}${start}" data-id="${r.ReleaseId}">
      <td>${dayCell}</td>
      <td>${esc(r.Band)}${r.Changed ? '<span class="changed" title="Changed here – not in the spreadsheet yet"></span>' : ''}</td>
      <td>${esc(r.Title)}</td>
      <td>${r.ReleaseYear}</td>
      <td>${esc(chart)}</td>
      <td class="notes">${esc(r.TagNotes || '')}</td>
      <td class="has">${r.ImageCount ? '🖼' : '<span class="miss" title="No cover">✕</span>'} ${r.HasWriteUp ? '✎' : '<span class="miss" title="No write-up">✕</span>'}</td>
      <td><button type="button" class="redbtn" data-red="${r.ReleaseId}" title="${c === 'red' ? 'Take off do-not-post' : 'Mark as do not post (red)'}">${c === 'red' ? 'Undo' : "Don't post"}</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">Nothing to show.</td></tr>';
}

async function setColour(id, colour) {
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.classList.add('saving');
  const res = await fetch('/api/manage/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, colour })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { alertBox(body.error || 'Could not save'); if (tr) tr.classList.remove('saving'); return; }
  const r = rows.find(x => x.ReleaseId === id);
  r.Status = body.status; r.OnSonos = colour === 'green'; r.Changed = true;
  render(); pending();
}

function alertBox(msg) { $('pending').textContent = ' ' + msg; }

async function pending() {
  try {
    const res = await fetch('/api/manage/status-overrides');
    const { overrides } = await res.json();
    $('pending').textContent = overrides.length
      ? ` ${overrides.length} change${overrides.length === 1 ? '' : 's'} (marked with a dot) still to be copied into the spreadsheet.` : '';
  } catch { /* ignore */ }
}

document.addEventListener('click', e => {
  const m = e.target.closest('[data-m]');
  if (m) { month = +m.dataset.m; load(); return; }
  const red = e.target.closest('[data-red]');
  if (red) { const id = +red.dataset.red; const r = rows.find(x => x.ReleaseId === id); setColour(id, colourOf(r) === 'red' ? 'none' : 'red'); return; }
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr.r');
  if (tr) { const id = +tr.dataset.id; const r = rows.find(x => x.ReleaseId === id); setColour(id, NEXT[colourOf(r)]); }
});
['fMissing', 'fHideRed'].forEach(id => $(id).addEventListener('change', render));
$('fText').addEventListener('input', render);

async function loadVisits() {
  try {
    const v = await (await fetch('/api/manage/visits?days=30')).json();
    const total = v.byDay.reduce((s, d) => s + d.Views, 0), mob = v.byDay.reduce((s, d) => s + d.Mobile, 0);
    const max = Math.max(1, ...v.byDay.map(d => d.Views));
    const bars = v.byDay.map(d => `<div class="vbar" title="${d.ViewDate.slice(0, 10)}: ${d.Views}"><i style="height:${Math.round(d.Views / max * 100)}%"></i></div>`).join('');
    const list = (rows, k) => rows.length ? '<ol>' + rows.map(r => `<li>${esc(r[k] || '(direct)')} <span class="muted">${r.Views}</span></li>`).join('') + '</ol>' : '<p class="muted">None yet.</p>';
    $('visitBody').innerHTML = total
      ? `<p><b>${total}</b> page views · ${Math.round(mob / total * 100)}% on phones</p><div class="vbars">${bars}</div>
         <div class="vcols"><div><h3>Pages</h3>${list(v.pages, 'Path')}</div><div><h3>Came from</h3>${list(v.refs, 'RefHost')}</div></div>`
      : 'No visits counted yet – the site is still sign-in only, so this starts once it goes public.';
  } catch { $('visitBody').textContent = 'Couldn\'t load visitor numbers.'; }
}

load();
loadVisits();
