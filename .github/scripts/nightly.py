"""The site's once-a-day database run (see .github/workflows/nightly.yml).

1. Apply the admin saves and contact messages queued during the day.
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
st, raw = call('/api/manage/queue', tries=6)
if st != 200:
    print('Could not read the queue:', st, raw[:300]); sys.exit(1)
items = json.loads(raw)['items']
print(f'{len(items)} queued change(s)')
failed = 0
for it in items:
    st, raw = call(it['path'], it.get('method', 'POST'), it.get('body') or None, tries=3)
    ok = 200 <= st < 300
    print(f"  {it['queuedAt'][:16]} {it['route']}: {st} {'' if ok else raw[:200]}")
    if ok:
        call('/api/manage/queue', 'POST', json.dumps({'done': it['name']}))
    else:
        failed += 1   # left in the queue for tomorrow (and shown in the log)

# 2. Rebuild everything
y, m, d = uk.year, uk.month, uk.day
fixed = [f'/api/onthisday?month={m}&day={d}', '/api/week', '/api/guess', '/api/favourites', '/api/stats', '/api/years',
         f'/api/years/{y}', '/api/random', '/api/sitemap', '/api/search?all=1', f'/api/roundup/{uk:%Y-%m-%d}.jpg']
for p in fixed:
    st, _ = call(p)
    print(f'  {p} {st}')
st, raw = call('/api/manage/nightly' + ('?force=1' if len(items) - failed > 0 else ''))
urls = json.loads(raw)['urls'] if st == 200 else []
days = [f'/api/onthisday?month={mm}&day={dd}' for mm in range(1, 13)
        for dd in range(1, (datetime.date(2024 + (mm == 12), mm % 12 + 1, 1) - datetime.timedelta(days=1)).day + 1)]
todo = sorted(set(urls + days) - set(fixed))
with ThreadPoolExecutor(6) as ex:
    codes = list(ex.map(lambda p: call(p, tries=2, timeout=90)[0], todo))
print(f'Rebuilt {len(todo)} answers:', {c: codes.count(c) for c in set(codes)})

# 3. Weekly report (Mondays)
if uk.weekday() == 0 or os.environ.get('REPORT') == '1':
    st, raw = call('/api/report', tries=3)
    if st == 200:
        open('report.json', 'wb').write(raw)
        print('Weekly report saved')
    else:
        print('Weekly report failed:', st, raw[:200])
sys.exit(1 if failed else 0)
