// In-memory live state + on-disk daily history for the long-running local
// server. Normalization and day statistics live in dayStats.js (shared with
// the serverless entry point); history merge/trends logic in history.js.

const fs = require('fs');
const path = require('path');

const {
  tzForCenter, todayInTz, normalizeDateString, timeToMinutes, computeCenterSnapshot,
} = require('./dayStats');
const { mergeDayStats, trendsFromHistory, centerOverview, staffHours } = require('./history');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class Store {
  constructor() {
    this.centers = []; // [{id, name, tz}]
    this.live = new Map(); // centerId -> snapshot
    this.history = this.#loadHistory();
    this.lastSync = null;
    this.mode = 'starting';
    this.sync = { failures: 0, lastError: null, lastSuccessAt: null };
  }

  // A corrupt history file must never be silently discarded - it is the only
  // copy of every past day. Keep the bad file, say so loudly, and start fresh.
  #loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
      throw new Error('history file is not an object');
    } catch (e) {
      const salvage = `${HISTORY_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(HISTORY_FILE, salvage); } catch (e2) { /* best effort */ }
      console.error(`[store] history.json could not be read (${e.message}). Kept a copy at ${salvage} and started a new file.`);
      this.historyError = e.message;
      return {};
    }
  }

  // Write to a temp file and rename: a crash mid-write leaves the previous
  // history intact instead of truncating it to nothing.
  #saveHistory() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.history));
      fs.renameSync(tmp, HISTORY_FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean up */ }
      console.error('[store] could not save history:', e.message);
    }
  }

  setCenters(centers) {
    this.centers = centers.map((c) => ({ ...c, tz: tzForCenter(c.name) }));
  }

  // Called by the poller with the raw Radius rows for one center.
  updateCenter(centerId, students, employees) {
    const center = this.centers.find((c) => c.id === centerId);
    if (!center) return;
    const snap = computeCenterSnapshot(center, students, employees);
    this.live.set(centerId, { ...snap, error: null });
    mergeDayStats(this.history, snap.today, centerId, snap);
    this.lastSync = new Date().toISOString();
    this.#saveHistory();
  }

  markCenterError(centerId, message) {
    const prev = this.live.get(centerId) || {};
    this.live.set(centerId, { ...prev, error: message, updatedAt: new Date().toISOString() });
  }

  overview() {
    return {
      mode: this.mode,
      lastSync: this.lastSync,
      sync: { ...this.sync },
      centers: this.centers.map((c) => centerOverview(c, this.live.get(c.id) || {}, this.history, todayInTz(c.tz))),
    };
  }

  roster(centerId) {
    const l = this.live.get(Number(centerId));
    return l ? l.students : [];
  }

  trends(days = 30, centerId = null) {
    return trendsFromHistory(this.history, days, centerId);
  }

  staffHours(centerId = null, days = 7) {
    // each center carries its own local date - they span three timezones
    const centers = (centerId ? this.centers.filter((c) => c.id === Number(centerId)) : this.centers)
      .map((c) => ({ ...c, today: todayInTz(c.tz) }));
    return staffHours(this.history, centers, todayInTz('America/New_York'), days);
  }
}

module.exports = { Store, tzForCenter, todayInTz, timeToMinutes, normalizeDateString };
