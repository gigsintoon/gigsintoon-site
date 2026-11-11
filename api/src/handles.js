// Works out which @handle / #hashtag in the write-ups means which band, so the site can show
// "Bad Religion" (as a link to the band) instead of "@badreligion".
//
// For each release, the band's own tag is the one in the first paragraph that looks most like
// the band name (or, failing that, the first tag). Across all releases each tag goes to the band
// it was picked for most often. Tags that aren't a band (labels, venues, people) are left alone
// and shown as plain words.

// Tags that would otherwise be matched to the wrong band (labels / band members)
const IGNORE = new Set(['dangerbird', 'rigiddigits', 'alexloweh1']);
const TOKEN = /([@#])([A-Za-z0-9_.]*[A-Za-z0-9_])/g;

function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\b(the|a|an)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
}

// Similarity 0..1 (Ratcliff/Obershelp, same idea as Python's difflib)
function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  const match = (a, b) => {
    if (!a.length || !b.length) return 0;
    let best = 0, ai = 0, bi = 0;
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        let k = 0;
        while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
        if (k > best) { best = k; ai = i; bi = j; }
      }
    }
    if (!best) return 0;
    return best + match(a.slice(0, ai), b.slice(0, bi)) + match(a.slice(ai + best), b.slice(bi + best));
  };
  return 2 * match(a, b) / (a.length + b.length);
}

function score(bandNorm, tok) {
  const t = norm(tok);
  if (t.length > 2 && (bandNorm.includes(t) || t.includes(bandNorm))) return 1;
  return ratio(bandNorm, t);
}

// rows: [{ BandId, Name, W }] -> { tag(lowercase, no @/#): { id, name } }
function buildHandleMap(rows) {
  const counts = new Map();
  for (const r of rows) {
    const first = String(r.W || '').replace(/\r\n/g, '\n').split('\n\n')[0];
    const toks = [...first.matchAll(TOKEN)].map(m => m[2].toLowerCase()).filter(t => !IGNORE.has(t));
    if (!toks.length) continue;
    const nb = norm(r.Name);
    let best = toks[0], bestScore = -1;
    for (const t of toks) { const s = score(nb, t); if (s > bestScore) { best = t; bestScore = s; } }
    const pick = bestScore >= 0.5 ? best : toks[0];
    if (!counts.has(pick)) counts.set(pick, new Map());
    const c = counts.get(pick);
    const key = r.BandId + '|' + r.Name;
    c.set(key, (c.get(key) || 0) + 1);
  }
  const map = {};
  for (const [tok, c] of counts) {
    const [key] = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    const i = key.indexOf('|');
    map[tok] = { id: +key.slice(0, i), name: key.slice(i + 1) };
  }
  return map;
}

// Only the tags that appear in these write-ups (keeps responses small)
function handlesFor(map, texts) {
  const out = {};
  for (const t of texts) {
    for (const m of String(t || '').matchAll(TOKEN)) {
      const k = m[2].toLowerCase();
      if (map[k]) out[k] = map[k];
    }
  }
  return out;
}

module.exports = { buildHandleMap, handlesFor, norm };
