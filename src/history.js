// Daily-history storage + shared merge/trends logic.
//
// History shape: { "YYYY-MM-DD": { [centerId]: { visits, peak, staffPeak, byHour } } }
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
  return history;
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

module.exports = { mergeDayStats, trendsFromHistory, InMemoryHistory, UpstashHistory, KV_KEY };
