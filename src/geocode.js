// Geocoding for PUBLIC PLACES ONLY - school locations and ZIP-area centers.
// Individual student home addresses are never geocoded, sent anywhere, or
// stored. We look up:
//   - schools  -> OpenStreetMap / Nominatim place search (name, city, state)
//   - ZIP areas -> Zippopotam.us (ZIP code -> approximate area centroid)
// Both are free, keyless, receive only public info, and every result is
// cached (Upstash if configured, else a local file / memory) so each place is
// looked up at most once.

const fs = require('fs');
const path = require('path');

const CACHE_KEY = 'mathnasium:placegeo';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'placegeo.json');
const MAX_LOOKUPS_PER_CALL = 12; // keep each request quick; caches warm over time
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const ZIPPO = 'https://api.zippopotam.us/us/';
const UA = 'mathnasium-dashboard/1.0 (center analytics)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const base = url.replace(/\/$/, '');
  return {
    async load() {
      try {
        const res = await fetch(`${base}/get/${CACHE_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await res.json();
        return body.result ? JSON.parse(body.result) : {};
      } catch (e) { return {}; }
    },
    async save(obj) {
      try {
        await fetch(`${base}/set/${CACHE_KEY}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(obj),
        });
      } catch (e) { /* best effort */ }
    },
  };
}

const store = tryUpstash();
let mem = null;

async function loadCache() {
  if (store) return store.load();
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { mem = {}; }
  return mem;
}
async function saveCache(obj) {
  if (store) return store.save(obj);
  mem = obj;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (e) { /* best effort */ }
}

async function lookupSchool(name, city, state) {
  const q = [name, city, state].filter(Boolean).join(', ');
  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const arr = await res.json();
  if (arr && arr[0]) return [Number(arr[0].lat), Number(arr[0].lon)];
  return null;
}

async function lookupZip(zip) {
  const res = await fetch(ZIPPO + encodeURIComponent(zip), { headers: { Accept: 'application/json' } });
  if (!res.ok) return null; // 404 = unknown ZIP
  const body = await res.json();
  const places = body.places || [];
  if (!places.length) return null;
  const lat = places.reduce((a, p) => a + Number(p.latitude), 0) / places.length;
  const lng = places.reduce((a, p) => a + Number(p.longitude), 0) / places.length;
  return [lat, lng];
}

// schools: [{name, city, state}]   zips: [{zip, city, state}]
// Returns { schools: Map<name,{lat,lng}>, zips: Map<zip,{lat,lng}>, remaining }
async function geocodePlaces(schools, zips) {
  const cache = await loadCache();
  const outSchools = new Map();
  const outZips = new Map();
  let budget = MAX_LOOKUPS_PER_CALL;
  let dirty = false;
  let remaining = 0;

  for (const s of schools) {
    const key = `school|${(s.name || '').toLowerCase()}|${(s.city || '').toLowerCase()}|${(s.state || '').toLowerCase()}`;
    if (key in cache) { if (cache[key]) outSchools.set(s.name, { lat: cache[key][0], lng: cache[key][1] }); continue; }
    if (budget <= 0) { remaining++; continue; }
    budget--;
    try {
      const c = await lookupSchool(s.name, s.city, s.state);
      cache[key] = c; dirty = true;
      if (c) outSchools.set(s.name, { lat: c[0], lng: c[1] });
      await sleep(1100); // Nominatim asks for <= 1 request/second
    } catch (e) { /* leave uncached; retry next pass */ }
  }

  for (const z of zips) {
    const key = `zip|${z.zip}`;
    if (key in cache) { if (cache[key]) outZips.set(z.zip, { lat: cache[key][0], lng: cache[key][1] }); continue; }
    if (budget <= 0) { remaining++; continue; }
    budget--;
    try {
      const c = await lookupZip(z.zip);
      cache[key] = c; dirty = true;
      if (c) outZips.set(z.zip, { lat: c[0], lng: c[1] });
    } catch (e) { /* leave uncached; retry next pass */ }
  }

  if (dirty) await saveCache(cache);
  return { schools: outSchools, zips: outZips, remaining };
}

module.exports = { geocodePlaces };
