// Moved out of visitors.html (25 Nov 2026) so the CSP can block inline scripts.
const $ = id => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
const TZ_COUNTRY = { 'Europe/London': 'UK', 'Europe/Dublin': 'Ireland', 'Europe/Belfast': 'UK', 'America/New_York': 'USA (East)', 'America/Chicago': 'USA (Central)',
  'America/Denver': 'USA (Mountain)', 'America/Los_Angeles': 'USA (West)', 'America/Phoenix': 'USA (Arizona)', 'America/Toronto': 'Canada (East)', 'America/Vancouver': 'Canada (West)',
  'Australia/Sydney': 'Australia (Sydney)', 'Australia/Melbourne': 'Australia (Melbourne)', 'Australia/Brisbane': 'Australia (Brisbane)', 'Australia/Perth': 'Australia (Perth)',
  'Pacific/Auckland': 'New Zealand', 'Europe/Paris': 'France', 'Europe/Berlin': 'Germany', 'Europe/Madrid': 'Spain', 'Europe/Rome': 'Italy', 'Europe/Amsterdam': 'Netherlands',
  'Europe/Brussels': 'Belgium', 'Europe/Stockholm': 'Sweden', 'Europe/Oslo': 'Norway', 'Europe/Copenhagen': 'Denmark', 'Europe/Helsinki': 'Finland', 'Europe/Warsaw': 'Poland',
  'Europe/Lisbon': 'Portugal', 'Europe/Zurich': 'Switzerland', 'Europe/Vienna': 'Austria', 'Europe/Prague': 'Czechia', 'Asia/Tokyo': 'Japan', 'Asia/Kolkata': 'India',
  'Asia/Singapore': 'Singapore', 'America/Sao_Paulo': 'Brazil', 'America/Mexico_City': 'Mexico', 'Africa/Johannesburg': 'South Africa' };
function placeName(tz) {
  if (!tz || tz === 'Unknown') return 'Unknown';
  if (TZ_COUNTRY[tz]) return TZ_COUNTRY[tz];
  const parts = tz.split('/'); return parts.slice(1).join(' / ').replace(/_/g, ' ') + ' (' + parts[0] + ')';
}
function places(rows) {
  return rows.length ? '<ol>' + rows.map(r => `<li>${esc(placeName(r.Place))} <span class="muted">${r.Views}</span></li>`).join('') + '</ol>' : '<p class="muted">None yet - this started counting on 13 Nov 2026.</p>';
}
function week7(rows) {
  const by = {}; rows.forEach(r => { by[r.ViewDate.slice(0, 10)] = r.Views; });
  const days = []; const now = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()));
  for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setUTCDate(d.getUTCDate() - i); const k = d.toISOString().slice(0, 10);
    days.push({ k, n: by[k] || 0, label: d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) }); }
  const max = Math.max(1, ...days.map(d => d.n));
  return `<div class="w7">${days.map(d => `<div class="w7d"><span class="w7n">${d.n}</span><div class="w7b"><i style="height:${Math.round(d.n / max * 100)}%"></i></div><span class="w7l">${d.label}</span></div>`).join('')}</div>`;
}
async function loadVisits(days = 30, attempt = 1) {
  $('visitBody').textContent = attempt > 1 ? 'Still loading – the database was asleep, waking it up…' : 'Loading…';
  try {
    const r = await fetch('/api/manage/visits?days=' + days);
    if (r.status === 401 || r.status === 403 || r.redirected) {   // signed out (sessions expire after a while)
      $('visitBody').innerHTML = 'You\'ve been signed out. <a href="/.auth/login/aad?post_login_redirect_uri=/admin/visitors">Sign in again</a> to see the numbers.';
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const v = await r.json();
    const total = v.byDay.reduce((s, d) => s + d.Views, 0), mob = v.byDay.reduce((s, d) => s + d.Mobile, 0);
    const max = Math.max(1, ...v.byDay.map(d => d.Views));
    const bars = v.byDay.map(d => `<div class="vbar" title="${d.ViewDate.slice(0, 10)}: ${d.Views}"><i style="height:${Math.round(d.Views / max * 100)}%"></i></div>`).join('');
    const best = v.byDay.reduce((a, d) => d.Views > (a ? a.Views : 0) ? d : a, null);
    const list = (rows, k) => rows.length ? '<ol>' + rows.map(r => `<li>${esc(r[k] || '(direct)')} <span class="muted">${r.Views}</span></li>`).join('') + '</ol>' : '<p class="muted">None yet.</p>';
    $('visitBody').innerHTML = total
      ? `<div class="tiles"><div><b>${total}</b><span>page views</span></div><div><b>${Math.round(total / Math.max(1, v.byDay.length))}</b><span>a day on average</span></div>
           <div><b>${Math.round(mob / total * 100)}%</b><span>on phones</span></div><div><b>${best ? best.Views : 0}</b><span>busiest day${best ? ' · ' + new Date(best.ViewDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}</span></div></div>
         <h3>Last 7 days</h3>${week7(v.last7 || [])}
         <h3>Every day in this period</h3><div class="vbars">${bars}</div>
         <h3>Buttons pressed</h3>${(v.clicks || []).length ? '<ol>' + v.clicks.map(c => `<li>${esc(c.Name)} <span class="muted">${c.Count} in this period · ${c.Last7} in the last 7 days · ${c.Today} today</span></li>`).join('') + '</ol>' : '<p class="muted">Nobody has pressed Surprise me yet in this period.</p>'}
         <div class="vcols"><div><h3>Pages</h3>${list(v.pages, 'Path')}</div><div><h3>Came from</h3>${list(v.refs, 'RefHost')}</div>
           <div><h3>Where visitors are</h3>${places(v.places || [])}<p class="muted small">Worked out from each visitor's clock setting (time zone), so it's the region rather than an exact town.</p></div></div>`
      : '<p>No visits counted in this period yet.</p>';
  } catch {
    // Signed out? The site then sends the request off to the Microsoft sign-in page, which shows up here as a failed request.
    const me = await fetch('/api/me', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    if (me && !me.owner) {
      $('visitBody').innerHTML = 'You\'ve been signed out (sign-ins expire after a while). <a href="/.auth/login/aad?post_login_redirect_uri=/admin/visitors">Sign in again</a> to see the numbers.';
      return;
    }
    if (attempt < 3) return setTimeout(() => loadVisits(days, attempt + 1), 3000);   // first request after a quiet spell can time out
    $('visitBody').innerHTML = 'Couldn\'t load visitor numbers. <button type="button" class="ghost" id="visitRetry">Try again</button>';
    $('visitRetry').onclick = () => loadVisits(days);
  }
}
// The chosen period (7 days, 30 days…) is remembered on this browser for next time
function pickRange(d) {
  const b = document.querySelector(`#range [data-d="${d}"]`) || document.querySelector('#range [data-d="30"]');
  document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b));
  try { localStorage.setItem('visitorsRange', b.dataset.d); } catch { /* ignore */ }
  loadVisits(+b.dataset.d);
}
$('range').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) pickRange(b.dataset.d); });
let savedRange = '30';
try { savedRange = localStorage.getItem('visitorsRange') || '30'; } catch { /* ignore */ }
pickRange(savedRange);
