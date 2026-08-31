// Vercel serverless entry point. vercel.json rewrites every /api/* request
// here; the static dashboard in /public is served by Vercel directly.
//
// Required env vars on Vercel:
//   RADIUS_USERNAME, RADIUS_PASSWORD  - your Radius login
//   DASHBOARD_PASSWORD                - viewers must enter this (the page is
//                                       on a public URL and shows student
//                                       names, so it is mandatory here)
// Optional: Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_*)
// keeps trend history across deploys and cold starts.

const { RadiusClient } = require('../src/radiusClient');
const { MockRadiusClient } = require('../src/mock');
const { DashboardService } = require('../src/service');
const {
  isAuthenticated, checkPassword, authCookieHeader, readJsonBody,
} = require('../src/auth');

const MOCK = !process.env.RADIUS_USERNAME || !process.env.RADIUS_PASSWORD;
// On Vercel the page must never be open to the world, so with no
// DASHBOARD_PASSWORD configured it falls back to the default below.
const PASSWORD = process.env.DASHBOARD_PASSWORD || (process.env.VERCEL ? '1234' : '');

// Module scope survives between requests while the instance is warm.
const client = MOCK
  ? new MockRadiusClient()
  : new RadiusClient({ username: process.env.RADIUS_USERNAME, password: process.env.RADIUS_PASSWORD });
const service = new DashboardService(client, { mode: MOCK ? 'mock' : 'live' });

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  // The cron ping just refreshes data + history; it returns no center data,
  // so it stays open (worst case a stranger refreshes our cache).
  if (path === '/api/cron') {
    try {
      await service.refresh();
      return json(res, 200, { ok: true, lastSync: service.lastSync });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  if (path === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (checkPassword(body.password, PASSWORD)) {
      res.setHeader('Set-Cookie', authCookieHeader(PASSWORD, req));
      return json(res, 200, { ok: true });
    }
    return json(res, 401, { error: 'Wrong password' });
  }

  if (!isAuthenticated(req, PASSWORD)) {
    return json(res, 401, { error: 'auth required' });
  }

  try {
    if (path === '/api/overview') {
      await service.refresh();
      const body = service.overview();
      if (MOCK && process.env.VERCEL) {
        body.note = 'Showing demo data - add RADIUS_USERNAME and RADIUS_PASSWORD in Vercel (Settings → Environment Variables) and redeploy to see your real centers.';
      }
      return json(res, 200, body);
    }
    const rosterMatch = /^\/api\/roster\/(\d+)$/.exec(path);
    if (rosterMatch) {
      await service.refresh();
      return json(res, 200, { students: service.roster(rosterMatch[1]) });
    }
    if (path === '/api/trends') {
      await service.refresh();
      const days = Math.min(Number(url.searchParams.get('days')) || 30, 120);
      const center = url.searchParams.get('center') ? Number(url.searchParams.get('center')) : null;
      return json(res, 200, { days: service.trends(days, center) });
    }
  } catch (e) {
    return json(res, 502, { error: 'Radius sync failed: ' + e.message });
  }

  return json(res, 404, { error: 'not found' });
};
