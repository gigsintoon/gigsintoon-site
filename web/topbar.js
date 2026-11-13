// The public top bar (menu, band search and social links), identical on every page that isn't the main app.
(function () {
  const bar = document.querySelector('header.top .wrap.bar');
  if (!bar) return;
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
  const links = [['On this day', '/'], ['Favourites', '/?page=favourites'], ['This week', '/?page=week'], ['Stats', '/?page=stats'],
                 ['Guess the cover', '/?page=guess'], ['About', '/about'], ['Contact', '/contact']];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  bar.innerHTML = `<a class="brand" href="/">Gigs in <span>toon</span></a>
    <nav class="nav">${links.map(([t, h]) => `<a href="${h}"${h === here ? ' class="on" aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
    <form class="search" role="search" id="tbSearch">
      <input type="search" placeholder="Search bands…" autocomplete="off" aria-label="Search bands">
      <div class="results" hidden></div>
    </form>
    <nav class="social" aria-label="Gigs in toon on social media">
        <a href="https://x.com/gigsintoon" target="_blank" rel="noopener" title="@gigsintoon on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h7l4.8 6.3L18.9 2zm-1.2 18h1.9L6.4 3.9H4.4L17.7 20z"/></svg></a>
        <a href="https://www.instagram.com/gigsintoon" target="_blank" rel="noopener" title="@gigsintoon on Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM12 2c-2.7 0-3 0-4.1.1C4.3 2.2 2.2 4.3 2.1 7.9 2 9 2 9.3 2 12s0 3 .1 4.1c.1 3.6 2.2 5.7 5.8 5.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c3.6-.1 5.7-2.2 5.8-5.8.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c-.1-3.6-2.2-5.7-5.8-5.8C15 2 14.7 2 12 2zm0 1.8c2.7 0 3 0 4 .1 2.6.1 3.9 1.4 4 4 .1 1 .1 1.3.1 4s0 3-.1 4c-.1 2.6-1.4 3.9-4 4-1 .1-1.3.1-4 .1s-3 0-4-.1c-2.6-.1-3.9-1.4-4-4-.1-1-.1-1.3-.1-4s0-3 .1-4c.1-2.6 1.4-3.9 4-4 1-.1 1.3-.1 4-.1z"/></svg></a>
        <a href="https://bsky.app/profile/gigsintoon.bsky.social" target="_blank" rel="noopener" title="@gigsintoon.bsky.social on Bluesky"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 3.3C7.7 5.2 10.4 9 11.4 11c1-2 3.7-5.8 6.2-7.7 1.8-1.4 4.8-2.4 4.8 1 0 .7-.4 5.7-.6 6.5-.8 2.8-3.6 3.5-6.1 3.1 4.4.8 5.5 3.2 3.1 5.7-4.6 4.7-6.6-1.2-7.1-2.7l-.3-.8-.3.8c-.5 1.5-2.5 7.4-7.1 2.7-2.4-2.5-1.3-4.9 3.1-5.7-2.5.4-5.3-.3-6.1-3.1-.2-.8-.6-5.8-.6-6.5 0-3.4 3-2.4 4.8-1z"/></svg></a>
      </nav>`;
  const form = bar.querySelector('#tbSearch'), box = form.querySelector('input'), out = form.querySelector('.results');
  let t;
  box.addEventListener('input', () => {
    clearTimeout(t);
    const q = box.value.trim();
    if (q.length < 2) { out.hidden = true; return; }
    t = setTimeout(async () => {
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then(r => r.json());
        const bands = r.bands || [];
        out.innerHTML = bands.length
          ? bands.map(b => `<a class="sr" href="/?band=${b.BandId}"><span>${esc(b.Name)}</span><span class="muted">${b.ReleaseCount}</span></a>`).join('')
          : '<p class="muted" style="padding:9px 12px;margin:0">No bands found</p>';
        out.hidden = false;
      } catch (e) { /* ignore while typing */ }
    }, 250);
  });
  form.addEventListener('submit', e => { e.preventDefault(); const a = out.querySelector('a'); if (a) location.href = a.href; });
  document.addEventListener('click', e => { if (!form.contains(e.target)) out.hidden = true; });
})();
