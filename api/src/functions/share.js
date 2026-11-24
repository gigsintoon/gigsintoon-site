const { app } = require('@azure/functions');

// Share links with proper preview cards.
// X, Bluesky, WhatsApp, Facebook etc. don't run the site's JavaScript, so a link like /?gig=150 always shows the
// general site card. These short links (/gig/150, /day/11-15, /band/701) are rewritten here by staticwebapp.config.json:
// we send back a tiny page with that gig's / day's / band's title, text and picture, which sends people on to the real page.
// The details come from the site's own public API (its ready-made answers), so a crawler doesn't wake the database
// and only things visitors can already see are ever shown.
const BASE = 'https://www.gigsintoon.co.uk';
const DEFAULT_IMG = BASE + '/share.jpg';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
const clip = (s, n = 200) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const niceDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`; };
const list = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

async function api(path) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  try { const r = await fetch(BASE + path, { signal: c.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

async function cardFor(kind, key) {
  if (kind === 'gig' && /^\d{1,6}$/.test(key)) {
    const target = `/?gig=${key}`;
    const g = (await api(`/api/gigs/${key}`) || {}).gig;
    if (!g) return { target };
    const bands = (g.Bands || []).map(b => b.Name);
    const head = bands[0] + (bands.length > 1 ? ' with ' + list(bands.slice(1)) : '');
    const img = (g.Images || [])[0];
    return { target, photo: !!img, image: img ? img.Url : DEFAULT_IMG,
      imageAlt: img ? (img.AltText || `${bands[0]} at ${g.Venue}`) : 'Gigs in toon',
      title: `${head} – ${g.Venue}, ${niceDate(g.GigDate)}`,
      description: clip(g.WriteUp) || `Gig memory: ${head} at ${g.Venue}${g.TourName ? ' (' + g.TourName + ')' : ''}.` };
  }
  if (kind === 'day' && /^\d{2}-\d{2}$/.test(key)) {
    const [m, d] = key.split('-').map(Number);
    const target = `/?date=${key}`;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return { target };
    const day = await api(`/api/onthisday?month=${m}&day=${d}`) || {};
    const rel = day.releases || [], gigs = day.gigs || [];
    const label = `${ord(d)} ${MONTHS[m - 1]}`;
    const bits = [];
    if (rel.length) bits.push(`${rel.length} release${rel.length === 1 ? '' : 's'} from my collection, including ${list(rel.slice(0, 3).map(r => `${r.Title} by ${r.Artist} (${r.ReleaseYear})`))}`);
    if (gigs.length) bits.push(`gig memories of ${list(gigs.slice(0, 3).map(g => String(g.Bands || '').split(' / ')[0] + ` (${g.GigYear})`))}`);
    const cover = rel.find(r => r.CoverUrl);
    return { target, image: cover ? cover.CoverUrl : DEFAULT_IMG,
      imageAlt: cover ? `Cover of ${cover.Title} by ${cover.Artist}` : 'Gigs in toon',
      title: `On this day, ${label} – Gigs in toon`,
      description: bits.length ? clip(`On the ${label}: ${bits.join(', and ')}.`, 240) : `What came out on the ${label}, from a lifetime of music I love.` };
  }
  if (kind === 'band' && /^\d{1,6}$/.test(key)) {
    const target = `/?band=${key}`;
    const b = await api(`/api/bands/${key}`);
    if (!b || !b.band) return { target };
    const rel = b.releases || [], gigs = b.gigs || [];
    const cover = rel.find(r => r.CoverUrl);
    const bits = [];
    if (rel.length) bits.push(`${rel.length} release${rel.length === 1 ? '' : 's'} in my collection`);
    if (gigs.length) bits.push(`${gigs.length} gig memor${gigs.length === 1 ? 'y' : 'ies'}`);
    return { target, image: cover ? cover.CoverUrl : DEFAULT_IMG,
      imageAlt: cover ? `Cover of ${cover.Title} by ${b.band.Name}` : 'Gigs in toon',
      title: `${b.band.Name} – Gigs in toon`,
      description: bits.length ? `${b.band.Name} on Gigs in toon: ${list(bits)}, each on the day it happened.` : `${b.band.Name} on Gigs in toon.` };
  }
  return { target: '/' };
}

function page(c, url) {
  const title = c.title || 'Gigs in toon – music on the day it happened';
  const desc = c.description || 'A lifetime of music I love – my collection and gig memories, on the day they happened.';
  const image = c.image || DEFAULT_IMG;
  const big = !c.image || c.image === DEFAULT_IMG || c.photo;   // covers are square: small card; photos and the banner: large
  const to = esc(c.target || '/');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(BASE + (c.target || '/'))}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Gigs in toon">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(c.imageAlt || 'Gigs in toon')}">
${image === DEFAULT_IMG ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : ''}
<meta name="twitter:card" content="${big ? 'summary_large_image' : 'summary'}"><meta name="twitter:site" content="@gigsintoon">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${to}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh}a{color:#f5b041}</style>
</head><body><p><a href="${to}">${esc(title)}</a></p>
<script>try{sessionStorage.setItem('landing',JSON.stringify({p:location.pathname,r:document.referrer,t:Date.now()}))}catch(e){}location.replace(${JSON.stringify(c.target || '/')});</script></body></html>`;
}

app.http('share', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'share',
  handler: async (request) => {
    // The address the visitor (or crawler) asked for, e.g. https://www.gigsintoon.co.uk/gig/150
    let path = '';
    try { path = new URL(request.headers.get('x-ms-original-url') || '', BASE).pathname; } catch { }
    if (!/^\/(gig|day|band)\//.test(path)) path = '/' + String(request.query.get('p') || '').replace(/^\/+/, '');
    const m = /^\/(gig|day|band)\/([\w-]{1,10})\/?$/.exec(path);
    const c = m ? await cardFor(m[1], m[2]) : { target: '/' };
    return { status: 200, body: page(c, BASE + (m ? `/${m[1]}/${m[2]}` : '/')),
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } };
  }
});
