// Shared by the simple public pages (about, contact, privacy, 404): footer year and the visit counter.
// (Moved out of inline <script> tags on 25 Nov 2026 so the CSP can block inline scripts.)
(function () {
  var yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear();
  try { fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ path: location.pathname, ref: document.referrer, tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '') }) }); } catch (e) { /* ignore */ }
})();
