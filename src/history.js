// Daily-history storage + shared merge/trends logic.
//
// History shape: { "YYYY-MM-DD": { [centerId]: { visits, peak, staffPeak, byHour,
//   understaffed (minutes), staffMin: { employeeId: { name, min } } } } }
// Older records stored staffMin as { name: minutes }; readStaffMin normalizes
// both shapes so existing history keeps working.
//
// Backends:
//  - the local server keeps its own file (see store.js)
//  - on Vercel: Upstash Redis over REST when configured (survives restarts),
//    otherwise a per-instance in-memory object (today still works; older days
//    are lost on cold start).

function mergeDayStats(history, date, centerId, snap) {
  const day = (history[date] = history[date] || {});
  const rec = (day[centerId] = day[centerId] || { visits: 0, peak: 0, staffPeak: 0, byHour: {} });
  rec.visits = Math.max(rec.visits, snap.visitsToday);
  rec.peak = Math.max(rec.peak, snap.peakToday);
  rec.staffPeak = Math.max(rec.staffPeak, snap.staffPeakToday);
  // keep the richer histogram (rows stop counting as "today" after midnight)
  const oldTotal = Object.values(rec.byHour).reduce((a, b) => a + b, 0);
  const newTotal = Object.values(snap.byHour).reduce((a, b) => a + b, 0);
  if (newTotal >= oldTotal) rec.byHour = { ...snap.byHour };
  rec.understaffed = Math.max(rec.understaffed || 0, snap.understaffedToday || 0);
  rec.staffMin = rec.staffMin || {};
  for (const [id, cur] of Object.entries(snap.staffMinutesToday || {})) {
    const prev = readOne(rec.staffMin[id]);
    rec.staffMin[id] = { name: cur.name, min: Math.max(prev ? prev.min : 0, cur.min) };
  }
  return history;
}

// Accepts both the current { name, min } shape and the legacy plain-number one.
function readOne(v) {
  if (v == null) return null;
  if (typeof v === 'number') return { name: null, min: v };
  return { name: v.name || null, min: Number(v.min) || 0 };
}

// --- week-level summaries read straight off the history ---------------------
const DAY = 86400000;
const isoOf = (d) => d.toISOString().slice(0, 10);
const dateOf = (iso) => new Date(iso + 'T00:00:00Z');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function visitsOn(history, iso, centerId) {
  const rec = history[iso] && history[iso][centerId];
  return rec ? rec.visits || 0 : null;
}

// For one center as of `todayIso` (the center's local date):
//   weekVisits / lastWeekVisits - Monday..today, this week vs the same span last week
//   last7Visits                - the trailing 7 days including today
//   typicalVisits              - average for this weekday over the previous 8 weeks
//   understaffedWeek           - understaffed minutes over the trailing 7 days
function centerWeekStats(history, centerId, todayIso) {
  const today = dateOf(todayIso);
  const dow = today.getUTCDay();
  const sinceMonday = (dow + 6) % 7;
  const sum = (fromOffset, toOffset) => {
    let n = 0;
    for (let o = fromOffset; o <= toOffset; o++) n += visitsOn(history, isoOf(new Date(today.getTime() - o * DAY)), centerId) || 0;
    return n;
  };
  const weekVisits = sum(0, sinceMonday);
  const lastWeekVisits = sum(7, 7 + sinceMonday);
  const last7Visits = sum(0, 6);
  const samples = [];
  for (let w = 1; w <= 8; w++) {
    const v = visitsOn(history, isoOf(new Date(today.getTime() - w * 7 * DAY)), centerId);
    if (v != null) samples.push(v);
  }
  const typicalVisits = samples.length >= 2 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
  let understaffedWeek = 0;
  for (let o = 0; o <= 6; o++) {
    const rec = history[isoOf(new Date(today.getTime() - o * DAY))]?.[centerId];
    understaffedWeek += rec ? rec.understaffed || 0 : 0;
  }
  return { weekVisits, lastWeekVisits, last7Visits, typicalVisits, weekday: WEEKDAYS[dow], understaffedWeek };
}

// The per-center row both runtimes put in /api/overview. Defined once here so
// the long-running server and the serverless service cannot drift apart.
// `snap` is a computeCenterSnapshot result (or {} before the first sync).
function centerOverview(center, snap, history, todayIso) {
  return {
    id: center.id,
    name: center.name,
    tz: center.tz,
    checkedIn: snap.checkedIn ?? null,
    staffIn: snap.staffIn ?? null,
    visitsToday: snap.visitsToday ?? null,
    rosterCount: snap.rosterCount ?? null,
    inNow: snap.inNow || [],
    staffNow: snap.staffNow || [],
    byHourToday: snap.byHour || (history[todayIso] || {})[center.id]?.byHour || {},
    ratio: snap.ratioNow ?? null,
    ratioLevel: snap.ratioLevel || null,
    understaffedToday: snap.understaffedToday ?? null,
    coverage: snap.coverageToday || [],
    ...centerWeekStats(history, center.id, todayIso),
    updatedAt: snap.updatedAt || null,
    error: snap.error || null,
  };
}

// Instructor minutes over the trailing `days` days for the given centers.
// Each center's window is measured in ITS OWN timezone - the centers span
// Eastern to Pacific, so a single "today" would shift a day near midnight.
function staffHours(history, centers, todayIso, days = 7) {
  const acc = new Map(); // `${centerId}|${employeeId}` -> row
  for (const c of centers) {
    const today = dateOf(c.today || todayIso);
    for (let o = 0; o < days; o++) {
      const iso = isoOf(new Date(today.getTime() - o * DAY));
      const rec = history[iso] && history[iso][c.id];
      if (!rec || !rec.staffMin) continue;
      for (const [id, raw] of Object.entries(rec.staffMin)) {
        const cur = readOne(raw);
        if (!cur || !cur.min) continue;
        const key = `${c.id}|${id}`;
        const e = acc.get(key)
          || { id, name: cur.name || id, centerId: c.id, center: c.name, minutes: 0, days: 0, todayMinutes: 0 };
        if (cur.name) e.name = cur.name;
        e.minutes += cur.min; e.days += 1;
        if (o === 0) e.todayMinutes = cur.min;
        acc.set(key, e);
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.minutes - a.minutes);
}

function trendsFromHistory(history, days = 30, centerId = null) {
  const out = [];
  const dates = Object.keys(history).sort().slice(-days);
  for (const date of dates) {
    const day = history[date];
    let visits = 0;
    let peak = 0;
    const byHour = {};
    for (const [cid, rec] of Object.entries(day)) {
      if (centerId && Number(cid) !== Number(centerId)) continue;
      visits += rec.visits;
      peak += rec.peak;
      for (const [h, n] of Object.entries(rec.byHour)) byHour[h] = (byHour[h] || 0) + n;
    }
    out.push({ date, visits, peak, byHour });
  }
  return out;
}

// Union of two history blobs, taking the larger value for every counter -
// merges are always additive, so a concurrent writer can only add days.
function mergeHistories(base, incoming) {
  const out = { ...base };
  for (const [date, day] of Object.entries(incoming || {})) {
    const target = (out[date] = { ...(out[date] || {}) });
    for (const [cid, rec] of Object.entries(day || {})) {
      const prev = target[cid];
      if (!prev) { target[cid] = rec; continue; }
      const byHour = { ...(prev.byHour || {}) };
      for (const [hh, n] of Object.entries(rec.byHour || {})) byHour[hh] = Math.max(byHour[hh] || 0, n);
      const staffMin = { ...(prev.staffMin || {}) };
      for (const [id, raw] of Object.entries(rec.staffMin || {})) {
        const a = readOne(staffMin[id]);
        const b = readOne(raw);
        if (b) staffMin[id] = { name: b.name || (a && a.name) || null, min: Math.max(a ? a.min : 0, b.min) };
      }
      target[cid] = {
        ...prev,
        ...rec,
        visits: Math.max(prev.visits || 0, rec.visits || 0),
        peak: Math.max(prev.peak || 0, rec.peak || 0),
        staffPeak: Math.max(prev.staffPeak || 0, rec.staffPeak || 0),
        understaffed: Math.max(prev.understaffed || 0, rec.understaffed || 0),
        byHour,
        staffMin,
      };
    }
  }
  return out;
}

class InMemoryHistory {
  constructor() { this.data = {}; }
  async load() { return this.data; }
  async save(obj) { this.data = obj; }
}

// Upstash Redis REST (also accepts the env names Vercel's KV/Marketplace sets)
const KV_KEY = 'mathnasium:history';

class UpstashHistory {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.cache = null;
  }

  static fromEnv() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? new UpstashHistory(url, token) : null;
  }

  async #read() {
    const res = await fetch(`${this.url}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const body = await res.json();
    const parsed = body.result ? JSON.parse(body.result) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  async load() {
    try {
      this.cache = await this.#read();
    } catch (e) {
      // storage briefly unreachable - fall back to last known copy
      this.cache = this.cache || {};
    }
    return this.cache;
  }

  // The whole history lives under one key, so two instances writing at once
  // would each overwrite the other's day. Re-read immediately before writing
  // and merge, so a concurrent write loses nothing.
  async save(obj) {
    this.cache = obj;
    try {
      let merged = obj;
      try { merged = mergeHistories(await this.#read(), obj); } catch (e) { /* write what we have */ }
      this.cache = merged;
      await fetch(`${this.url}/set/${KV_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(merged),
      });
    } catch (e) { /* keep serving from cache; next save retries */ }
  }
}

module.exports = {
  mergeDayStats, mergeHistories, trendsFromHistory, centerWeekStats, centerOverview, staffHours,
  InMemoryHistory, UpstashHistory, KV_KEY,
};
