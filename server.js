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
const { isAuthenticated, checkPassword, authCookieHeader } = require('./src/auth');
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

app.post('/api/login', (req, res) => {
  if (checkPassword(req.body && req.body.password, DASH_PASSWORD)) {
    res.setHeader('Set-Cookie', authCookieHeader(DASH_PASSWORD, req));
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
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
app.get('/api/center/:id', async (req, res) => {
  try {
    let center = store.centers.find((c) => String(c.id) === req.params.id);
    if (!center) {
      const list = await client.getCenters();
      const c = list.find((x) => String(x.id) === req.params.id);
      if (c) center = { ...c, tz: tzForCenter(c.name) };
    }
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
