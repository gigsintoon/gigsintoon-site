// The gold admin bar, the same on every admin page (and on the main site when signed in as owner).
(function () {
  const LINKS = [
    ['Release list', '/admin'], ['Add release', '/admin/add'], ['Messages', '/admin/messages'],
    ['To do', '/admin/todo'], ['Visitors', '/admin/visitors'], ['Settings', '/admin/settings']
  ];
  const here = location.pathname.replace(/\.html$/, '').replace(/^\/(add|messages|todo|visitors|settings)$/, '/admin/$1').replace(/\/$/, '') || '/';
  window.adminBarHtml = function (extra = '') {
    return `<div class="wrap"><span class="abt">Admin</span><nav class="anav">${LINKS.map(([t, h]) =>
      `<a href="${h}"${here === h ? ' class="on" aria-current="page"' : ''}>${t}</a>`).join('')}</nav>${extra}
      <a class="signout" href="/logout">Sign out</a></div>`;
  };
  const slot = document.getElementById('adminBar');
  if (slot && slot.dataset.static !== undefined) slot.innerHTML = window.adminBarHtml(`<a class="viewsite" href="/">View site ↗</a>`);
})();
// Keep sticky table headers just under the (now taller) header
(function () {
  const set = () => { const h = document.querySelector('header.top'); if (h) document.documentElement.style.setProperty('--hdr', h.offsetHeight + 'px'); };
  addEventListener('load', set); addEventListener('resize', set); set();
})();
