// Mathnasium live dashboard server.
//
//   npm start        -> live mode (needs RADIUS_USERNAME / RADIUS_PASSWORD in .env)
//   npm run mock     -> demo mode with invented data, no credentials needed
//
// The server logs into Radius, polls attendance for every center on an
// interval, and serves the dashboard plus a small JSON API. Credentials
// never leave this process; the dashboard itself only sees derived data.

require('dotenv').config();
const express = require('express');
const path = require('path');

const { RadiusClient } = require('./src/radiusClient');
const { Store } = require('./src/store');
const { Poller } = require('./src/poller');
const { MockRadiusClient, seedHistory } = require('./src/mock');

const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1'
  || !process.env.RADIUS_USERNAME || !process.env.RADIUS_PASSWORD;
const PORT = Number(process.env.PORT || 5014);
const HOST = process.env.HOST || '127.0.0.1';
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);

const store = new Store();
let client;
if (MOCK) {
  client = new MockRadiusClient();
  store.mode = 'mock';
  seedHistory(store);
  if (!process.argv.includes('--mock') && process.env.MOCK !== '1') {
    console.log('! RADIUS_USERNAME / RADIUS_PASSWORD not set - starting in MOCK mode.');
    console.log('  Copy .env.example to .env and fill it in for live data.');
  }
} else {
  client = new RadiusClient({
    username: process.env.RADIUS_USERNAME,
    password: process.env.RADIUS_PASSWORD,
  });
}

const poller = new Poller(client, store, {
  intervalSeconds: MOCK ? 30 : POLL_SECONDS,
  modeLabel: MOCK ? 'mock' : 'live',
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Optional password protection (mandatory on Vercel; opt-in locally via .env)
const { isAuthenticated, checkPassword, authCookieHeader, loginAllowed, loginFailed, loginSucceeded } = require('./src/auth');
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

app.post('/api/login', (req, res) => {
  if (!loginAllowed(req)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (checkPassword(req.body && req.body.password, DASH_PASSWORD)) {
    loginSucceeded(req);
    res.setHeader('Set-Cookie', authCookieHeader(DASH_PASSWORD, req));
    return res.json({ ok: true });
  }
  loginFailed(req);
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/health', (req, res) => {
  const bad = (store.sync && store.sync.failures >= 2);
  res.status(bad ? 503 : 200).json({ ok: !bad, mode: store.mode, lastSync: store.lastSync, sync: store.sync });
});

app.use('/api', (req, res, next) => {
  if (isAuthenticated(req, DASH_PASSWORD)) return next();
  res.status(401).json({ error: 'auth required' });
});

app.get('/api/overview', (req, res) => {
  res.json(store.overview());
});

app.get('/api/roster/:centerId', (req, res) => {
  res.json({ students: store.roster(req.params.centerId) });
});

app.get('/api/trends', (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 120);
  const center = req.query.center ? Number(req.query.center) : null;
  res.json({ days: store.trends(days, center) });
});

const { CenterDetailProvider } = require('./src/detailService');
const { tzForCenter } = require('./src/dayStats');
const detailProvider = new CenterDetailProvider(client);

async function allCenters() {
  if (store.centers.length) return store.centers;
  const list = await client.getCenters();
  return list.map((c) => ({ ...c, tz: tzForCenter(c.name) }));
}

app.get('/api/staff-hours', (req, res) => {
  res.json({ rows: store.staffHours(req.query.center ? Number(req.query.center) : null) });
});

const { buildDigest, sendDigest, digestConfigured } = require('./src/digest');
async function makeDigest(req) {
  const all = await detailProvider.detailAll(await allCenters());
  const url = process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}`;
  return buildDigest({ overview: store.overview(), all, hours: store.staffHours(null), dashboardUrl: url });
}
app.get('/api/digest', async (req, res) => {
  try {
    const d = await makeDigest(req);
    if (req.query.send === '1') {
      const r = await sendDigest(d);
      return res.status(r.ok ? 200 : 502).json({ ...r, configured: digestConfigured() });
    }
    res.type('html').send(d.html);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/center/all', async (req, res) => {
  try {
    res.json(await detailProvider.detailAll(await allCenters()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/center/:id', async (req, res) => {
  try {
    let center = (await allCenters()).find((c) => String(c.id) === req.params.id);
    if (!center) return res.status(404).json({ error: 'unknown center' });
    res.json(await detailProvider.detail(center));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Mathnasium dashboard ${MOCK ? '(MOCK data) ' : ''}running at http://${HOST}:${PORT}`);
  poller.start();
});
