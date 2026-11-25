// Used by the share-card pages (/day/.., /gig/.., /band/..): remembers which short link was clicked and where the
// visitor came from (for the visitor counts), then moves on to the real page. Kept in a file so the CSP can block inline scripts.
(function () {
  var s = document.currentScript, to = (s && s.getAttribute('data-to')) || '/';
  if (to.charAt(0) !== '/' || to.charAt(1) === '/') to = '/';
  try { sessionStorage.setItem('landing', JSON.stringify({ p: location.pathname, r: document.referrer, t: Date.now() })); } catch (e) { /* ignore */ }
  location.replace(to);
})();
