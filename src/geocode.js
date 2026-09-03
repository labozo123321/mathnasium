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
  // Same one-key race as the history blob: re-read and merge so a parallel
  // request's freshly geocoded places are not thrown away. Entries are
  // immutable once written, so a plain union is correct.
  if (store) return store.save({ ...(await store.load()), ...obj });
  mem = obj;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (e) { /* best effort */ }
}

async function lookupSchool(name, city, state) {
  const q = [name, city, state].filter(Boolean).join(', ');
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
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

// --- Center locations (public business addresses) ---------------------------
// A Mathnasium center is a public business, so it is looked up by name on
// Nominatim. The hit is sanity-checked against where the center's students
// are (their schools/ZIP centroid): a result more than ~60 km away is
// rejected in favour of the center's town, and failing that the centroid.
const MAX_CENTER_LOOKUPS_PER_CALL = 4;
const MAX_KM_FROM_STUDENTS = 60;

function kmBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

async function nominatim(q, limit = 3, attempt = 0) {
  const url = `${NOMINATIM}?format=json&limit=${limit}&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 2) { await sleep(3000 * (attempt + 1)); return nominatim(q, limit, attempt + 1); }
  if (!res.ok) throw new Error('nominatim ' + res.status);
  const arr = await res.json();
  return Array.isArray(arr) ? arr : [];
}

// list: [{ id, name, city, state, anchor: [lat,lng] | null }]
// Returns { centers: Map<id,{lat,lng,approx}>, remaining }
async function geocodeCenters(list) {
  const cache = await loadCache();
  const out = new Map();
  let budget = MAX_CENTER_LOOKUPS_PER_CALL;
  let dirty = false;
  let remaining = 0;
  const near = (pt, anchor) => !anchor || kmBetween(pt, anchor) <= MAX_KM_FROM_STUDENTS;

  for (const c of list) {
    const key = `center|${(c.name || '').toLowerCase()}|${(c.state || '').toLowerCase()}`;
    const hit = cache[key];
    if (hit && near([hit[0], hit[1]], c.anchor)) { out.set(c.id, { lat: hit[0], lng: hit[1], approx: hit[2] !== 'business' }); continue; }
    if (budget <= 0) {
      remaining++;
      if (c.anchor) out.set(c.id, { lat: c.anchor[0], lng: c.anchor[1], approx: true });
      continue;
    }
    let found = null;
    try {
      budget--;
      const hits = await nominatim(`Mathnasium ${c.name}, ${c.state || ''}`);
      const biz = hits.find((r) => /mathnasium/i.test(r.display_name || '') && near([Number(r.lat), Number(r.lon)], c.anchor));
      if (biz) found = [Number(biz.lat), Number(biz.lon), 'business'];
      await sleep(1100);
      if (!found && c.city && budget > 0) {
        budget--;
        const towns = await nominatim(`${c.city}, ${c.state || ''}`, 1);
        const t = towns[0];
        if (t && near([Number(t.lat), Number(t.lon)], c.anchor)) found = [Number(t.lat), Number(t.lon), 'city'];
        await sleep(1100);
      }
    } catch (e) {
      remaining++; // a rate-limit or network hiccup: the page polls again shortly
      if (process.env.DEBUG_GEO) console.warn('[geo] center lookup failed for', c.name, e.message);
    }
    if (process.env.DEBUG_GEO) console.warn('[geo] center', c.name, 'anchor', c.anchor, '->', found);
    if (found) { cache[key] = found; dirty = true; out.set(c.id, { lat: found[0], lng: found[1], approx: found[2] !== 'business' }); }
    else if (c.anchor) out.set(c.id, { lat: c.anchor[0], lng: c.anchor[1], approx: true });
  }

  if (dirty) await saveCache(cache);
  return { centers: out, remaining };
}

module.exports = { geocodePlaces, geocodeCenters, kmBetween };
