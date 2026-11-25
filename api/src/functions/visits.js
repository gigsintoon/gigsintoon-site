const { app } = require('@azure/functions');
const {
  query, json, fail, store, isOwner, isRunner, crypto, M, S, visitData, ukDay, dayBefore, tallyFor, scoresFor
} = require('../shared-releases');

app.http('hit', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'hit',
  handler: async (request, context) => {
    if (isOwner(request)) return { status: 204 };           // don't count Micky's own visits
    const ua = request.headers.get('user-agent') || '';
    if (/bot|crawl|spider|preview|monitor/i.test(ua)) return { status: 204 };
    try {
      const b = await request.json().catch(() => ({}));
      // A button press (e.g. "Surprise me") is counted on its own, not as a page view
      const CLICKS = { surprise: 'Surprise me' };
      if (b.click) {
        if (CLICKS[b.click]) await store.incr('clicks', ukDay(), b.click, { Count: 1 }, { Name: CLICKS[b.click] });
        return { status: 204 };
      }
      const path = String(b.path || '/').replace(/[?#].*$/, '').slice(0, 200) || '/';
      let ref = '';
      try { ref = b.ref ? new URL(b.ref).hostname.replace(/^www\./, '') : ''; } catch { ref = ''; }
      if (/gigsintoon\.co\.uk$/.test(ref)) ref = '';
      const device = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
      // Counted in Table Storage (no database wake-up for visitors); keyed by UK date
      const today = ukDay();
      const tz = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(String(b.tz || '')) ? String(b.tz).slice(0, 60) : 'Unknown';
      await Promise.all([
        store.incr('pageviews', today, `${path}|${ref.slice(0, 200)}|${device}`, { Views: 1 }, { Path: path, RefHost: ref.slice(0, 200), Device: device }),
        store.incr('pageplaces', today, tz, { Views: 1 }, { Place: tz }).catch(() => {})
      ]);
      return { status: 204 };
    } catch (err) {
      context.error(err);
      return { status: 204 };
    }
  }
});

// GET /api/manage/visits?days=30 (owner only) -> page views by day, page and referrer
app.http('visits', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'manage/visits',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    const days = Math.min(365, Math.max(1, parseInt(request.query.get('days'), 10) || 30));
    try {
      const { byDay, pages, refs, places, last7, clicks } = await visitData(days);
      return json({ days, byDay, pages, refs, places, last7, clicks });
    } catch (err) {
      return fail(context, err);
    }
  }
});

// GET /api/report  (header x-report-key) -> weekly summary for the email: visits, messages, to-dos.
// Only a hash of the key is kept (music.Settings); the GitHub Action that collects the report has the key as a secret.
app.http('report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'report',
  handler: async (request, context) => {
    try {
      const storage = await M.on();
      const hashNow = storage ? await S.reportKeyHash() : ((await query(`SELECT Value FROM music.Settings WHERE Name = N'ReportKeyHash'`))[0] || {}).Value;
      const want = hashNow ? Buffer.from(hashNow, 'hex') : null;
      const got = crypto.createHash('sha256').update(request.headers.get('x-report-key') || '').digest();
      if (!want || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return json({ error: 'Not allowed.' }, 403);
      let visits = null;
      try {
        const { byDay, pages, refs, clicks } = await visitData(8, 10);
        visits = { byDay, pages, refs, buttonPresses: clicks };
      } catch { visits = { unavailable: 'Visitor table not set up yet (run db/003-visits-and-permissions.sql).' }; }
      const fromStorage = storage ? await S.reportData() : null;
      const messages = fromStorage ? fromStorage.messages : (await query(`SELECT ReceivedAt, Name, Topic, LEFT(Body, 600) AS Body, CASE WHEN Email IS NULL OR Email = '' THEN 0 ELSE 1 END AS HasEmail
          FROM music.Messages WHERE IsRead = 0 AND DeletedAt IS NULL ORDER BY ReceivedAt`))
        .map(m => ({ at: m.ReceivedAt, name: m.Name, topic: m.Topic, message: m.Body, hasEmail: !!m.HasEmail }));
      const todos = fromStorage ? fromStorage.todos : (await query(`SELECT Owner, Title, Answer FROM music.Todos WHERE Done = 0 ORDER BY CreatedAt`))
        .map(t => ({ owner: t.Owner, title: t.Title, answer: t.Answer || '' }));
      const additions = fromStorage ? fromStorage.additions : (await query(`SELECT COUNT(*) AS n FROM music.SiteAdditions`))[0].n;
      let gday = ukDay(), guess = { tries: 0, correct: 0, days: 0 };
      for (let i = 0; i < 7; i++) { gday = dayBefore(gday); const t = await tallyFor(gday); guess.tries += t.tries; guess.correct += t.correct; if (t.tries) guess.days++; }
      const week = `last 7 days to ${dayBefore(ukDay())}`;
      const [counts] = fromStorage ? [fromStorage.counts] : await query(`SELECT (SELECT COUNT(*) FROM music.Releases) AS Releases, (SELECT COUNT(*) FROM music.Gigs) AS Gigs`);
      return json({ generated: new Date().toISOString(), visits, unreadMessages: messages, openTodos: todos, siteAdditionsWaiting: additions, guessTheCover: { week, ...guess }, counts });
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/health -> checks the database connection
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (request, context) => {
    try {
      const rows = await query(
        `SELECT (SELECT COUNT(*) FROM music.Bands) AS Bands,
                (SELECT COUNT(*) FROM music.Releases) AS Releases,
                (SELECT COUNT(*) FROM music.Gigs) AS Gigs`);
      return json({ ok: true, ...rows[0] });
    } catch (err) {
      context.error(err);
      return json({ ok: false, error: err.message }, 500);
    }
  }
});

// POST /api/manage/visits-import (owner, run once) -> copy the page views counted in SQL before 15 Nov 2026 into Table Storage
app.http('visitsImport', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'manage/visits-import',
  handler: async (request, context) => {
    if (!isOwner(request)) return json({ error: 'Not allowed.' }, 403);
    try {
      if (await store.get('pageviews', 'meta', 'imported')) return json({ ok: true, already: true });
      const pv = await query(`SELECT CONVERT(char(10), ViewDate, 23) AS D, Path, RefHost, Device, Views FROM music.PageViews`);
      for (const r of pv) await store.incr('pageviews', r.D, `${r.Path}|${r.RefHost}|${r.Device}`, { Views: r.Views }, { Path: r.Path, RefHost: r.RefHost, Device: r.Device });
      const pl = await query(`SELECT CONVERT(char(10), ViewDate, 23) AS D, Place, Views FROM music.PageViewPlaces`).catch(() => []);
      for (const r of pl) await store.incr('pageplaces', r.D, r.Place, { Views: r.Views }, { Place: r.Place });
      await store.put('pageviews', 'meta', 'imported', { At: new Date().toISOString(), Rows: pv.length + pl.length });
      return json({ ok: true, pageViews: pv.length, places: pl.length });
    } catch (err) { return fail(context, err); }
  }
});

// GET /api/nightly/visits?days=7 - the visitor counts for the overnight-run key (GitHub "Visitors now" action),
// so Claude can check them without a browser. Storage only: never touches the database.
app.http('nightlyVisits', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'nightly/visits',
  handler: async (request, context) => {
    if (!isRunner(request)) return json({ error: 'Only the overnight-run key.' }, 403);
    try {
      const days = Math.min(Math.max(parseInt(request.query.get('days') || '7', 10) || 7, 1), 90);
      const { byDay, pages, refs, clicks } = await visitData(days, 10);
      const d = ukDay();
      const guess = { tally: await tallyFor(d).catch(() => null),
        scores: (await scoresFor(d).catch(() => [])).map(x => ({ guesses: x.guesses, at: null })) };
      return json({ today: d, byDay, pages, refs, clicks, guess });
    } catch (err) { return fail(context, err); }
  }
});
