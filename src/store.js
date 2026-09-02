// In-memory live state + on-disk daily history for the long-running local
// server. Normalization and day statistics live in dayStats.js (shared with
// the serverless entry point); history merge/trends logic in history.js.

const fs = require('fs');
const path = require('path');

const {
  tzForCenter, todayInTz, normalizeDateString, timeToMinutes, computeCenterSnapshot,
} = require('./dayStats');
const { mergeDayStats, trendsFromHistory } = require('./history');

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

  #loadHistory() {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  #saveHistory() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history));
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
      centers: this.centers.map((c) => {
        const l = this.live.get(c.id) || {};
        return {
          id: c.id,
          name: c.name,
          tz: c.tz,
          checkedIn: l.checkedIn ?? null,
          staffIn: l.staffIn ?? null,
          visitsToday: l.visitsToday ?? null,
          rosterCount: l.rosterCount ?? null,
          inNow: l.inNow || [],
          staffNow: l.staffNow || [],
          byHourToday: this.history[todayInTz(c.tz)]?.[c.id]?.byHour || {},
          updatedAt: l.updatedAt || null,
          error: l.error || null,
        };
      }),
    };
  }

  roster(centerId) {
    const l = this.live.get(Number(centerId));
    return l ? l.students : [];
  }

  trends(days = 30, centerId = null) {
    return trendsFromHistory(this.history, days, centerId);
  }
}

module.exports = { Store, tzForCenter, todayInTz, timeToMinutes, normalizeDateString };
