"""Build import files for the Gigs in toon database from the spreadsheet + day folders.

Usage:  python3 build_import.py "<Gigs in toon folder>" <month numbers...>
        e.g. python3 build_import.py ~/mnt/"Gigs in toon" 11

Writes <folder>/_import/upload/releases-MM-1.json and -2.json (1st-15th, 16th-end) and _import/report-MM.txt (unmatched files/rows).
Images are referenced by their path inside the folder, which is also their path in the
"media" blob container once the month folders are uploaded.
"""
import datetime, difflib, json, os, re, sys, unicodedata
from urllib.parse import quote
import openpyxl

MONTH_DIRS = ['01 - January', '02 - February', '03 - March', '04 - April', '05 - May', '06 - June',
              '07 - July', '08 - August', '09 - September', '10 - October', '11 - November', '12 - December']
SHEETS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
          'September', 'October', 'November', 'December']
IMG_EXT = ('.jpg', '.jpeg', '.png', '.jfif', '.webp', '.gif')
TODAY = datetime.date.today()


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


ALIASES = {'ratm': 'rage against the machine', 'pusa': 'presidents of the united states of america',
           'pod': 'p.o.d.', 'mcr': 'my chemical romance', 'ltj': 'less than jake', 'rbf': 'reel big fish',
           'bfs': 'bowling for soup', 'msp': 'manic street preachers', 'hifh': 'hell is for heroes',
           'ffdp': 'five finger death punch', 'nfg': 'new found glory', 'sws': 'sleeping with sirens'}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    s = s.replace('&', ' and ')
    s = re.sub(r'\b(the|a|an)\b', ' ', s)
    return re.sub(r'[^a-z0-9]+', '', s)


def colour(cell):
    fg = cell.fill.fgColor if cell.fill and cell.fill.fill_type else None
    if fg is None:
        return None
    if fg.type == 'rgb' and str(fg.rgb).upper().endswith('FF0000'):
        return 'red'
    if fg.type == 'theme':
        return {9: 'green', 5: 'orange'}.get(fg.theme)
    return None


def parse_chart(v):
    if v is None or str(v).strip() in ('', '???'):
        return None, None
    s = str(v).strip()
    m = re.search(r'\b(?:no\.?|number)\s*(\d{1,3})\b', s, re.I)
    if m:
        rest = (s[:m.start()] + s[m.end():]).strip(' ,-;')
        return int(m.group(1)), (rest or None)
    return None, s


def release_type(title, write_up):
    """Decide from the title and the first paragraph of the write-up (later paragraphs often
    mention the album a single came from, so they're ignored)."""
    ti = str(title).lower()
    first = (write_up or '').strip().split('\n\n')[0].lower()
    if re.search(r'\bep\b', ti) or re.search(r'\bep\b', first):
        return 'EP'
    if re.search(r'\bsingle\b', ti) or re.search(r'\bsingles?\b', first) and not re.search(r'singles (collection|compilation)|the singles\b', first):
        return 'Single'
    if 'live album' in first:
        return 'Live'
    if any(k in first for k in ('compilation', 'greatest hit', 'best of', 'singles collection', 'b-sides', 'b sides', 'rarities')) \
            or any(k in ti for k in ('greatest hits', 'best of', 'anthology', 'rarities', 'b-sides')):
        return 'Compilation'
    if re.search(r'\blive\b', ti):
        return 'Live'
    if 'album' in first or 'record' in first:
        return 'Album'
    return 'Other'


def day_files(folder):
    """Return {stem: {'txt': path, 'images': [(kind, path)]}} for one day folder."""
    out = {}
    if not os.path.isdir(folder):
        return out
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        stem, ext = os.path.splitext(f)
        ext = ext.lower()
        if f.lower() == 'desktop.ini' or re.match(r'^GIG\s*-', stem, re.I):
            continue
        kind = 'Cover'
        m = re.search(r'\s*(CD\s?([123]))$', stem, re.I)
        if m:
            kind = 'CD' + m.group(2)
            stem = stem[:m.start()]
        stem = stem.strip().rstrip('.')
        key = re.sub(r'\s+', ' ', stem.lower())  # 'Paul weller' and 'Paul Weller' are the same release
        e = out.setdefault(key, {'txt': None, 'images': [], 'name': stem})
        if ext == '.txt':
            e['txt'] = p
        elif ext in IMG_EXT:
            e['images'].append((kind, p))
    # "Title 1.jpg" / "Title 2.jpg" with no .txt of their own are extra pictures of "Title"
    for key in list(out):
        m = re.match(r'^(.*\S)\s+(\d)$', key)
        if m and out[key]['txt'] is None and m.group(1) in out:
            out[m.group(1)]['images'].extend(out.pop(key)['images'])
        elif m and out[key]['txt'] is None:
            base = m.group(1)
            twin = [k for k in list(out) if k != key and re.match(re.escape(base) + r'\s+\d$', k)]
            if twin:
                merged = out.setdefault(base, {'txt': None, 'images': [], 'name': out[key]['name'][:-2]})
                merged['images'].extend(out.pop(key)['images'])
    return out


def split_stem(stem):
    if ' - ' in stem:
        a, t = stem.split(' - ', 1)
        return a.strip(), t.strip()
    return '', stem.strip()


def best_match(band, title, candidates, used, e_names=None):
    e_names = e_names or {}
    """candidates: list of stems. Score on artist + title similarity."""
    nb, nt = norm(band), norm(title)
    best, best_score = None, 0.0
    for stem in candidates:
        if stem in used:
            continue
        a, t = split_stem(e_names.get(stem, stem))
        a = ALIASES.get(norm(a), a)
        if norm(t) in ALIASES:
            t = ALIASES[norm(t)]
        na, ntt = norm(a), norm(t)
        ts = difflib.SequenceMatcher(None, nt, ntt).ratio() if nt and ntt else 0
        if nt and ntt and (nt in ntt or ntt in nt):
            ts = max(ts, 0.9)
        as_ = difflib.SequenceMatcher(None, nb, na).ratio() if nb and na else 0.5
        if nb and na and (nb in na or na in nb):
            as_ = max(as_, 0.9)
        score = ts * 0.65 + as_ * 0.35
        if score > best_score:
            best, best_score = stem, score
    return best, best_score


def good_match(*a, **k):
    best, score = best_match(*a, **k)
    return (best, score) if score >= 0.72 else (None, score)


def read_txt(p):
    for enc in ('utf-8-sig', 'cp1252', 'latin-1'):
        try:
            with open(p, encoding=enc) as fh:
                return fh.read().replace('\r\n', '\n').strip()
        except UnicodeDecodeError:
            continue
    return None


def build_month(root, wb, mi):
    ws = wb[SHEETS[mi - 1]]
    mdir = os.path.join(root, MONTH_DIRS[mi - 1])
    rows, report, seen = [], [], set()
    files_by_day, used_by_day = {}, {}
    for r in range(2, ws.max_row + 1):
        day, band, title, year = (ws.cell(r, c).value for c in range(1, 5))
        if not (isinstance(day, (int, float)) and band and title and isinstance(year, (int, float))):
            if band or title:
                report.append(f"Row {r}: skipped (missing day/year): {band} - {title} ({year})")
            continue
        day, year = int(day), int(year)
        try:
            date = datetime.date(year, mi, day)
        except ValueError:
            report.append(f"Row {r}: invalid date {day}/{mi}/{year}: {band} - {title}")
            continue
        band_s, title_s = str(band).strip(), str(title).strip()
        key = (norm(band_s), norm(title_s), date)
        if key in seen:
            report.append(f"Row {r}: duplicate row skipped: {band_s} - {title_s}")
            continue
        seen.add(key)
        chart, chart_note = parse_chart(ws.cell(r, 5).value)
        notes = [str(ws.cell(r, c).value).strip() for c in range(6, 9) if ws.cell(r, c).value not in (None, '', ' ')]
        tag_notes = next((n for n in notes if n.lower().startswith('tag')), None)
        if chart is None and chart_note and chart_note.lower().startswith('tag'):
            tag_notes, chart_note = chart_note, None
        c = colour(ws.cell(r, 2)) or colour(ws.cell(r, 1))
        if c == 'red':
            status, sonos = 'DoNotPost', False
        elif c == 'green':
            status, sonos = 'Posted', True
        elif c == 'orange':
            status, sonos = ('Posted' if date.replace(year=TODAY.year) < TODAY else 'Drafted'), False
        else:
            status, sonos = 'NotPosted', False

        dfolder = os.path.join(mdir, ordinal(day))
        if day not in files_by_day:
            files_by_day[day] = day_files(dfolder)
            used_by_day[day] = set()
        stem, score = good_match(band_s, title_s, list(files_by_day[day]), used_by_day[day],
                                 {k: v['name'] for k, v in files_by_day[day].items()})
        write_up, images = None, []
        if stem:
            used_by_day[day].add(stem)
            e = dict(files_by_day[day][stem]); e['images'] = list(e['images'])
            # The cover and the .txt are sometimes spelt slightly differently ("Thiss Is Music",
            # "Gigilo Aunts") - if one half is missing, take it from the closest unused file that day.
            if not e['txt'] or not e['images']:
                need = 'txt' if not e['txt'] else 'images'
                spare = [k for k, v in files_by_day[day].items() if k not in used_by_day[day] and v[need]]
                twin, ts = best_match(band_s, title_s, spare, set(), {k: files_by_day[day][k]['name'] for k in spare})
                if twin and ts >= 0.6:
                    used_by_day[day].add(twin)
                    e[need] = files_by_day[day][twin][need]
                    if need == 'images':
                        e['images'] = list(e['images'])
            if e['txt']:
                write_up = read_txt(e['txt'])
            order = {'Cover': 0, 'CD1': 1, 'CD2': 2, 'CD3': 3}
            for i, (kind, p) in enumerate(sorted(e['images'], key=lambda x: order.get(x[0], 9)), 1):
                rel = os.path.relpath(p, root).replace(os.sep, '/')
                images.append({'kind': kind, 'path': rel, 'urlPath': quote(rel), 'order': i})
        else:
            report.append(f"{ordinal(day)}: no file match for sheet row {r}: {band_s} - {title_s}")

        artist_display = band_s if '/' in band_s else None
        band_name = band_s.split('/')[0].strip() if '/' in band_s else band_s
        rows.append({
            'band': band_name, 'artistDisplay': artist_display, 'title': title_s,
            'type': release_type(title_s, write_up), 'date': date.isoformat(),
            'chart': chart, 'chartNote': chart_note, 'label': None,
            'writeUp': write_up, 'tagNotes': tag_notes, 'status': status, 'onSonos': sonos,
            'images': images})

    for day, files in sorted(files_by_day.items()):
        for stem, e in files.items():
            if stem not in used_by_day[day]:
                report.append(f"{ordinal(day)}: file not matched to any sheet row: {e['name']}")
    return rows, report


def main():
    root = os.path.expanduser(sys.argv[1])
    months = [int(m) for m in sys.argv[2:]] or list(range(1, 13))
    wb = openpyxl.load_workbook(os.path.join(root, 'MUSIC RELEASESv7.xlsx'))
    out = os.path.join(root, '_import')
    os.makedirs(out, exist_ok=True)
    up = os.path.join(out, 'upload')
    os.makedirs(up, exist_ok=True)
    for mi in months:
        rows, report = build_month(root, wb, mi)
        # Two files per month (1st-15th, 16th-end) so each import finishes inside the web timeout
        for part, keep in ((1, lambda d: d <= 15), (2, lambda d: d > 15)):
            chunk = [r for r in rows if keep(int(r['date'][8:10]))]
            with open(os.path.join(up, f'releases-{mi:02d}-{part}.json'), 'w', encoding='utf-8') as fh:
                json.dump(chunk, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(out, f'report-{mi:02d}.txt'), 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(report) + '\n')
        n_txt = sum(1 for r in rows if r['writeUp'])
        n_img = sum(len(r['images']) for r in rows)
        print(f"{SHEETS[mi-1]}: {len(rows)} releases, {n_txt} with write-ups, {n_img} images, {len(report)} report lines")


if __name__ == '__main__':
    main()
