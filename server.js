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
app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, HOST, () => {
  console.log(`Mathnasium dashboard ${MOCK ? '(MOCK data) ' : ''}running at http://${HOST}:${PORT}`);
  poller.start();
});
