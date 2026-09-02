// On-demand dashboard service for serverless hosting (Vercel).
//
// Instead of a background poller, a full Radius pass runs when the dashboard
// is viewed (with a short cache so several viewers / auto-refreshes share one
// pass). Every pass folds today's numbers into the history backend, and a
// daily cron near closing time captures the day even when nobody looked.

const { tzForCenter, computeCenterSnapshot } = require('./dayStats');
const { mergeDayStats, trendsFromHistory, InMemoryHistory, UpstashHistory } = require('./history');

class DashboardService {
  constructor(client, { mode = 'live', historyImpl = null, cacheTtlMs = 25000, log = console } = {}) {
    this.client = client;
    this.mode = mode;
    this.history = historyImpl || UpstashHistory.fromEnv() || new InMemoryHistory();
    this.persistent = !(this.history instanceof InMemoryHistory);
    this.cacheTtlMs = cacheTtlMs;
    this.log = log;
    this.centers = [];
    this.snapshots = new Map(); // centerId -> snapshot
    this.lastSync = null;
    this.lastPassAt = 0;
    this.inflight = null;
    this.sync = { failures: 0, lastError: null, lastSuccessAt: null };
  }

  async refresh() {
    if (Date.now() - this.lastPassAt < this.cacheTtlMs && this.snapshots.size) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.#pass()
      .then(() => { this.sync.failures = 0; this.sync.lastError = null; this.sync.lastSuccessAt = new Date().toISOString(); })
      .catch((e) => {
        this.sync.failures += 1;
        this.sync.lastError = e.message;
        this.lastPassAt = Date.now(); // don't hammer Radius while it's failing
        if (!this.snapshots.size) throw e; // nothing cached yet - surface the error
        // otherwise keep serving the last good snapshot and flag it as stale
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #pass() {
    if (!this.centers.length) {
      this.centers = (await this.client.getCenters()).map((c) => ({ ...c, tz: tzForCenter(c.name) }));
    }
    const results = await Promise.all(this.centers.map(async (center) => {
      try {
        const [students, employees] = await Promise.all([
          this.client.getStudentAttendance(center.id),
          this.client.getEmployeeAttendance(center.id),
        ]);
        return { center, snap: computeCenterSnapshot(center, students, employees) };
      } catch (e) {
        this.log.warn?.(`[service] ${center.name}: ${e.message}`);
        return { center, error: e.message };
      }
    }));

    const history = await this.history.load();
    let anyOk = false;
    for (const r of results) {
      if (r.snap) {
        anyOk = true;
        this.snapshots.set(r.center.id, { ...r.snap, error: null });
        mergeDayStats(history, r.snap.today, r.center.id, r.snap);
      } else {
        const prev = this.snapshots.get(r.center.id) || {};
        this.snapshots.set(r.center.id, { ...prev, error: r.error });
      }
    }
    if (anyOk) {
      this.lastSync = new Date().toISOString();
      await this.history.save(history);
    }
    this.historyCache = history;
    this.lastPassAt = Date.now();
    if (!anyOk) throw new Error(results[0]?.error || 'every center failed to sync');
  }

  overview() {
    return {
      mode: this.mode,
      lastSync: this.lastSync,
      persistentHistory: this.persistent,
      sync: { ...this.sync },
      centers: this.centers.map((c) => {
        const s = this.snapshots.get(c.id) || {};
        return {
          id: c.id,
          name: c.name,
          tz: c.tz,
          checkedIn: s.checkedIn ?? null,
          staffIn: s.staffIn ?? null,
          visitsToday: s.visitsToday ?? null,
          rosterCount: s.rosterCount ?? null,
          inNow: s.inNow || [],
          staffNow: s.staffNow || [],
          byHourToday: s.byHour || {},
          updatedAt: s.updatedAt || null,
          error: s.error || null,
        };
      }),
    };
  }

  roster(centerId) {
    const s = this.snapshots.get(Number(centerId));
    return s && s.students ? s.students : [];
  }

  trends(days = 30, centerId = null) {
    return trendsFromHistory(this.historyCache || {}, days, centerId);
  }
}

module.exports = { DashboardService };
