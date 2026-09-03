// Daily-history storage + shared merge/trends logic.
//
// History shape: { "YYYY-MM-DD": { [centerId]: { visits, peak, staffPeak, byHour,
//   understaffed (minutes), staffMin: { instructorName: minutes } } } }
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
  for (const [name, min] of Object.entries(snap.staffMinutesToday || {})) {
    rec.staffMin[name] = Math.max(rec.staffMin[name] || 0, min);
  }
  return history;
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

// Instructor minutes over the trailing `days` days for the given centers.
function staffHours(history, centers, todayIso, days = 7) {
  const today = dateOf(todayIso);
  const acc = new Map(); // `${centerId}|${name}` -> { name, centerId, minutes, days, todayMinutes }
  for (let o = 0; o < days; o++) {
    const iso = isoOf(new Date(today.getTime() - o * DAY));
    for (const c of centers) {
      const rec = history[iso] && history[iso][c.id];
      if (!rec || !rec.staffMin) continue;
      for (const [name, min] of Object.entries(rec.staffMin)) {
        if (!min) continue;
        const key = `${c.id}|${name}`;
        const e = acc.get(key) || { name, centerId: c.id, center: c.name, minutes: 0, days: 0, todayMinutes: 0 };
        e.minutes += min; e.days += 1;
        if (o === 0) e.todayMinutes = min;
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

  async load() {
    try {
      const res = await fetch(`${this.url}/get/${KV_KEY}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const body = await res.json();
      this.cache = body.result ? JSON.parse(body.result) : {};
    } catch (e) {
      // storage briefly unreachable - fall back to last known copy
      this.cache = this.cache || {};
    }
    return this.cache;
  }

  async save(obj) {
    this.cache = obj;
    try {
      await fetch(`${this.url}/set/${KV_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(obj),
      });
    } catch (e) { /* keep serving from cache; next save retries */ }
  }
}

module.exports = { mergeDayStats, trendsFromHistory, centerWeekStats, staffHours, InMemoryHistory, UpstashHistory, KV_KEY };
