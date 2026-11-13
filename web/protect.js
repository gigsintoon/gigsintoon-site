// Light copy protection for visitors: no right-click / drag on pictures, no selecting or copying text.
// (Admin pages and form fields are left alone. This deters casual copying; nothing on the web can fully stop it.)
(function () {
  if (/^\/admin/.test(location.pathname) || document.body.classList.contains('admin')) return;
  const owner = () => window.__ownerView;
  const inField = t => owner() || t && t.closest && t.closest('input, textarea, select, [contenteditable]');
  document.documentElement.classList.add('noshare');
  document.addEventListener('contextmenu', e => { if (!inField(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (!owner() && e.target.tagName === 'IMG') e.preventDefault(); });
  document.addEventListener('copy', e => { if (!inField(e.target)) { e.preventDefault(); } });
  document.addEventListener('keydown', e => {
    if (!owner() && (e.ctrlKey || e.metaKey) && ['s', 'u'].includes((e.key || '').toLowerCase())) e.preventDefault();
  });
})();
