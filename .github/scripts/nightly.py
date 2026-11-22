"""The site's once-a-day database run (see .github/workflows/nightly.yml).

1. Apply the admin saves and contact messages queued during the day.
   Then copy every table into Azure Storage and check the copy (moving off SQL, step 1 - see api/src/functions/export.js),
   and answer every public page from both SQL and the copy to check they match (step 2 - see api/src/functions/compare.js).
   Which one the pages actually use is the switch at /api/manage/data-source.
2. Rebuild every ready-made answer that's out of date (each day, this week, stats, band and gig pages,
   the admin lists Michael reads...), so visitors and Michael get them all day without waking the database.
3. On Mondays, fetch the weekly report.
Every request carries the report key, which marks it as the overnight run.
"""
import json, os, sys, time, datetime, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

BASE = 'https://www.gigsintoon.co.uk'
KEY = os.environ['REPORT_KEY']


def call(path, method='GET', body=None, tries=4, timeout=120):
    data = body.encode() if isinstance(body, str) else body
    for i in range(tries):
        req = urllib.request.Request(BASE + path, data=data, method=method,
                                     headers={'x-report-key': KEY, 'Content-Type': 'application/json', 'User-Agent': 'gigsintoon-nightly'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                return e.code, e.read()
        except Exception as e:  # timeouts while the database wakes up
            if i == tries - 1:
                return 0, str(e).encode()
        time.sleep(20)


uk = datetime.datetime.now(ZoneInfo('Europe/London'))
if os.environ.get('EVENT') == 'schedule' and uk.hour > 5:
    print(f'Not the small hours in the UK ({uk:%H:%M}) - skipping'); sys.exit(0)

# 1. Queued changes, oldest first. Waking the database can take a minute, so the first call retries.
st, raw = call('/api/nightly/queue', tries=6)
if st != 200:
    print('Could not read the queue:', st, raw[:300]); sys.exit(1)
items = json.loads(raw)['items']
print(f'{len(items)} queued change(s)')
failed = 0
for it in items:
    st, raw = call('/api/nightly/run', 'POST', json.dumps({k: it.get(k) for k in ('route', 'method', 'path', 'body')}), tries=2)
    ok = 200 <= st < 300
    print(f"  {it['queuedAt'][:16]} {it['route']}: {st} {'' if ok else raw[:300]}")
    if ok:
        call('/api/nightly/queue', 'POST', json.dumps({'done': it['name']}))
    else:
        failed += 1   # left in the queue for tomorrow (and shown in the log)

# 1b. Moving off SQL, step 1: copy every table into Azure Storage and check each copy matches SQL.
#     Nothing reads the copy yet; a mismatch is reported (and turns the run red) but doesn't stop the rebuild.
export_ok = True
copied = False
try:
    st, raw = call('/api/nightly/export' + ('?force=1' if len(items) - failed > 0 else ''), tries=2)
    if st == 200 and json.loads(raw).get('done'):
        print("Storage copy: today's copy already made and checked")
    elif st == 200:
        tables = json.loads(raw)['tables']
        results = []
        for t in tables:
            st, raw = call('/api/nightly/export', 'POST', json.dumps({'table': t}), tries=2, timeout=120)
            r = json.loads(raw) if st == 200 else {'table': t, 'ok': False, 'problems': [f'HTTP {st}: {raw[:200]!r}']}
            results.append(r)
            print(f"  copy {t}: {r.get('rows', '?')} rows {'OK' if r.get('ok') else 'PROBLEM ' + '; '.join(r.get('problems') or [])}")
        st, raw = call('/api/nightly/export', 'POST', json.dumps({'finish': True, 'results': results}), tries=2)
        summary = json.loads(raw) if st == 200 else {'ok': False, 'error': raw[:200].decode(errors='replace')}
        export_ok = bool(summary.get('ok'))
        copied = export_ok
        print(f"Storage copy: {'all ' + str(summary.get('tableCount')) + ' tables match' if export_ok else 'PROBLEM'} "
              f"({summary.get('totalRows', '?')} rows; missing {summary.get('missing')}, failed {summary.get('failed')})")
    else:
        export_ok = False
        print('Storage copy: could not list tables:', st, raw[:200])
except Exception as e:   # never let the copy stop the rebuild
    export_ok = False
    print("Storage copy: failed -", e)

# 1c. Moving off SQL, step 2: answer every public page both ways (SQL and the storage copy) and compare.
#     Only when a fresh copy was just made (once a night). Differences are reported; they don't stop the rebuild.
compare_ok = True
if export_ok and copied:
    try:
        tally, problems, off = {'same': 0, 'order': 0, 'different': 0, 'errors': 0}, [], 0
        while off is not None:
            st, raw = call(f'/api/nightly/compare?all=1&offset={off}&limit=40', tries=2, timeout=230)
            if st != 200:
                print('Side-by-side check: failed', st, raw[:200]); compare_ok = False; break
            r = json.loads(raw)
            for k in tally: tally[k] += r.get(k, 0)
            problems += [p for p in r.get('problems', []) if p.get('result') != 'order']
            off = r.get('next')
        print(f"Side-by-side check (SQL vs storage copy): {tally['same']} same, {tally['order']} same apart from order, "
              f"{tally['different']} different, {tally['errors']} errors")
        for p in problems[:15]:
            print('  ', p.get('path'), p.get('result'), json.dumps(p.get('diffs') or p.get('error'))[:400])
        compare_ok = compare_ok and tally['different'] == 0 and tally['errors'] == 0
    except Exception as e:
        compare_ok = False
        print('Side-by-side check: failed -', e)

# 2. Rebuild everything
y, m, d = uk.year, uk.month, uk.day
fixed = [f'/api/onthisday?month={m}&day={d}', '/api/week', '/api/guess', '/api/favourites', '/api/stats', '/api/years',
         f'/api/years/{y}', '/api/random', '/api/sitemap', '/api/search?all=1', f'/api/roundup/{uk:%Y-%m-%d}.jpg']
for p in fixed:
    st, _ = call(p)
    print(f'  {p} {st}')
st, raw = call('/api/nightly/urls' + ('?force=1' if len(items) - failed > 0 else ''))
urls = json.loads(raw)['urls'] if st == 200 else []
days = [f'/api/onthisday?month={mm}&day={dd}' for mm in range(1, 13)
        for dd in range(1, (datetime.date(2024 + (mm == 12), mm % 12 + 1, 1) - datetime.timedelta(days=1)).day + 1)]
todo = sorted(set(urls + days) - set(fixed))
def rebuild(p):
    if p.startswith('/api/manage/'):   # admin lists: read as the owner via /api/nightly/run
        route = p[5:].split('?')[0]
        return call('/api/nightly/run', 'POST', json.dumps({'route': route, 'method': 'GET', 'path': p}), tries=2, timeout=90)[0]
    return call(p, tries=2, timeout=90)[0]
with ThreadPoolExecutor(6) as ex:
    codes = list(ex.map(rebuild, todo))
print(f'Rebuilt {len(todo)} answers:', {c: codes.count(c) for c in set(codes)})

# 3. Weekly report (Mondays)
if uk.weekday() == 0 or os.environ.get('REPORT') == '1':
    st, raw = call('/api/report', tries=3)
    if st == 200:
        open('report.json', 'wb').write(raw)
        print('Weekly report saved')
    else:
        print('Weekly report failed:', st, raw[:200])
sys.exit(1 if failed or not export_ok else 0)
