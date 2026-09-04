// Vercel serverless entry point. vercel.json rewrites every /api/* request
// here; the static dashboard in /public is served by Vercel directly.
//
// Configuration - all optional on Vercel:
//   DASHBOARD_PASSWORD - viewers must enter this to open the page
//                        (defaults to "1234" on Vercel - never open)
//   RADIUS_USERNAME / RADIUS_PASSWORD - your Radius login. If not set, the
//        dashboard offers a "Connect your Radius account" form after unlock
//        and keeps the login in an HttpOnly cookie in that browser only.
//   Upstash Redis (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_*) - keeps
//        trend history across deploys and cold starts.

const { RadiusClient } = require('../src/radiusClient');
const { MockRadiusClient } = require('../src/mock');
const { DashboardService } = require('../src/service');
const { CenterDetailProvider } = require('../src/detailService');
const { todayInTz } = require('../src/dayStats');
const { buildDigest, sendDigest, digestConfigured } = require('../src/digest');
const {
  isAuthenticated, checkPassword, authCookieHeader, readJsonBody, parseCookies,
  sealCredentials, openCredentials, credentialKey, secureFlag,
  loginAllowed, loginFailed, loginSucceeded,
} = require('../src/auth');

// On Vercel the page must never be open to the world, so with no
// DASHBOARD_PASSWORD configured it falls back to the default below.
const PASSWORD = process.env.DASHBOARD_PASSWORD || (process.env.VERCEL ? '1234' : '');
const USING_DEFAULT_PASSWORD = !process.env.DASHBOARD_PASSWORD && !!process.env.VERCEL;
const RADIUS_COOKIE = 'mn_radius';
const YEAR = 60 * 60 * 24 * 365;

// Module scope survives between requests while the instance is warm.
const services = new Map(); // key -> DashboardService

function serviceFor(key, makeClient, mode) {
  if (!services.has(key)) {
    services.set(key, new DashboardService(makeClient(), { mode }));
  }
  return services.get(key);
}

// Resolve which Radius login to use: env vars win, then the browser cookie,
// otherwise demo data.
function resolveService(req) {
  if (process.env.RADIUS_USERNAME && process.env.RADIUS_PASSWORD) {
    return {
      mock: false,
      service: serviceFor('env', () => new RadiusClient({
        username: process.env.RADIUS_USERNAME,
        password: process.env.RADIUS_PASSWORD,
      }), 'live'),
    };
  }
  const creds = openCredentials(parseCookies(req)[RADIUS_COOKIE], PASSWORD);
  if (creds) {
    const { u, p } = creds;
    return {
      mock: false,
      service: serviceFor(credentialKey(u, p), () => new RadiusClient({ username: u, password: p }), 'live'),
    };
  }
  return { mock: true, service: serviceFor('mock', () => new MockRadiusClient(), 'mock') };
}

async function makeDigest(service, req) {
  await service.refresh();
  service.detailProvider = service.detailProvider || new CenterDetailProvider(service.client);
  const all = await service.detailProvider.detailAll(service.centers);
  const host = req.headers && req.headers.host;
  const url = process.env.DASHBOARD_URL || (host ? `https://${host}` : '');
  return buildDigest({ overview: service.overview(), all, hours: service.staffHours(null), dashboardUrl: url });
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const secure = secureFlag(req);

  // The cron ping just refreshes data + history; it returns no center data,
  // so it stays open (worst case a stranger refreshes our cache). It can only
  // use env-var credentials - browser-stored logins aren't available to it.
  if (path === '/api/health') {
    const { service, mock } = resolveService({ headers: {} });
    return json(res, service.sync.failures >= 2 ? 503 : 200, {
      ok: service.sync.failures < 2, mode: mock ? 'mock' : 'live',
      lastSync: service.lastSync, sync: service.sync, defaultPassword: USING_DEFAULT_PASSWORD,
    });
  }

  if (path === '/api/cron') {
    try {
      const { service } = resolveService({ headers: {} });
      await service.refresh();
      return json(res, 200, { ok: true, lastSync: service.lastSync });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  // Monday digest (Vercel cron). Sends only when Resend is configured; honors
  // CRON_SECRET when one is set so strangers can't trigger extra emails.
  if (path === '/api/digest-cron') {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (!digestConfigured()) return json(res, 200, { ok: false, skipped: 'RESEND_API_KEY / DIGEST_TO not set' });
    try {
      const { service } = resolveService({ headers: {} });
      const r = await sendDigest(await makeDigest(service, req));
      return json(res, r.ok ? 200 : 502, r);
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  if (path === '/api/login' && req.method === 'POST') {
    if (!(await loginAllowed(req))) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const body = await readJsonBody(req);
    if (checkPassword(body.password, PASSWORD)) {
      await loginSucceeded(req);
      res.setHeader('Set-Cookie', authCookieHeader(PASSWORD, req));
      return json(res, 200, { ok: true });
    }
    await loginFailed(req);
    return json(res, 401, { error: 'Wrong password' });
  }

  if (!isAuthenticated(req, PASSWORD)) {
    return json(res, 401, { error: 'auth required' });
  }

  // Save a Radius login (verified against Radius first) in this browser.
  if (path === '/api/radius-setup' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const u = String(body.username || '').trim();
    const p = String(body.password || '');
    if (!u || !p) return json(res, 400, { error: 'Enter both the Radius username and password.' });
    const client = new RadiusClient({ username: u, password: p });
    try {
      await client.login();
    } catch (e) {
      console.warn('[radius-setup] login failed:', e.message);
      return json(res, 401, {
        error: 'Radius did not accept that login. Double-check the username and password you use at radius.mathnasium.com.',
      });
    }
    const value = sealCredentials({ u, p }, PASSWORD);
    res.setHeader('Set-Cookie', `${RADIUS_COOKIE}=${value}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secure}`);
    services.set(credentialKey(u, p), new DashboardService(client, { mode: 'live' })); // reuse the verified session
    return json(res, 200, { ok: true });
  }

  // Forget the browser-stored Radius login.
  if (path === '/api/radius-disconnect' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `${RADIUS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    return json(res, 200, { ok: true });
  }

  try {
    const { service, mock } = resolveService(req);
    if (path === '/api/overview') {
      await service.refresh();
      const body = service.overview();
      body.defaultPassword = USING_DEFAULT_PASSWORD;
      if (mock && process.env.VERCEL) {
        body.canSetup = true;
        body.note = 'This is demo data. Connect your Radius login to see your real centers.';
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
    if (path === '/api/cohorts') {
      await service.refresh();
      service.detailProvider = service.detailProvider || new CenterDetailProvider(service.client);
      const id = url.searchParams.get('center');
      const center = id ? service.centers.find((c) => String(c.id) === id) : null;
      if (id && !center) return json(res, 404, { error: 'unknown center' });
      const months = Math.min(Number(url.searchParams.get('months')) || 24, 60);
      const tz = center ? center.tz : (service.centers[0] && service.centers[0].tz) || 'America/New_York';
      return json(res, 200, await service.detailProvider.cohorts(center, todayInTz(tz), months));
    }
    if (path === '/api/staff-hours') {
      await service.refresh();
      const center = url.searchParams.get('center') ? Number(url.searchParams.get('center')) : null;
      return json(res, 200, { rows: service.staffHours(center) });
    }
    if (path === '/api/digest') {
      const d = await makeDigest(service, req);
      if (url.searchParams.get('send') === '1') {
        const r = await sendDigest(d);
        return json(res, r.ok ? 200 : 502, { ...r, configured: digestConfigured() });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(d.html);
    }
    if (path === '/api/center/all') {
      await service.refresh();
      service.detailProvider = service.detailProvider || new CenterDetailProvider(service.client);
      return json(res, 200, await service.detailProvider.detailAll(service.centers));
    }
    const centerMatch = /^\/api\/center\/(\d+)$/.exec(path);
    if (centerMatch) {
      await service.refresh();
      const center = service.centers.find((c) => String(c.id) === centerMatch[1]);
      if (!center) return json(res, 404, { error: 'unknown center' });
      service.detailProvider = service.detailProvider || new CenterDetailProvider(service.client);
      return json(res, 200, await service.detailProvider.detail(center));
    }
  } catch (e) {
    return json(res, 502, { error: 'Radius sync failed: ' + e.message });
  }

  return json(res, 404, { error: 'not found' });
};
