// Polls Radius on an interval and feeds the store.
// One pass = student + employee attendance for every center, fetched
// sequentially with a small gap so we stay a polite client.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Poller {
  constructor(client, store, { intervalSeconds = 60, log = console, modeLabel = 'live' } = {}) {
    this.client = client;
    this.store = store;
    this.intervalSeconds = intervalSeconds;
    this.log = log;
    this.modeLabel = modeLabel;
    this.running = false;
    this.consecutiveFailures = 0;
  }

  async start() {
    this.running = true;
    while (this.running) {
      const startedAt = Date.now();
      await this.pollOnce();
      const elapsed = (Date.now() - startedAt) / 1000;
      const backoff = Math.min(this.consecutiveFailures * 30, 300);
      const wait = Math.max(this.intervalSeconds - elapsed, 5) + backoff;
      await sleep(wait * 1000);
    }
  }

  async pollOnce() {
    try {
      if (!this.store.centers.length) {
        this.store.setCenters(await this.client.getCenters());
        this.log.info?.(`[poller] centers: ${this.store.centers.map((c) => c.name).join(', ')}`);
      }
      for (const center of this.store.centers) {
        try {
          const students = await this.client.getStudentAttendance(center.id);
          await sleep(400);
          const employees = await this.client.getEmployeeAttendance(center.id);
          this.store.updateCenter(center.id, students, employees);
        } catch (e) {
          this.log.warn?.(`[poller] ${center.name}: ${e.message}`);
          this.store.markCenterError(center.id, e.message);
        }
        await sleep(400);
      }
      this.store.mode = this.modeLabel;
      this.consecutiveFailures = 0;
      this.store.sync = { failures: 0, lastError: null, lastSuccessAt: new Date().toISOString() };
    } catch (e) {
      this.consecutiveFailures += 1;
      this.log.warn?.(`[poller] pass failed (${this.consecutiveFailures}): ${e.message}`);
      this.store.sync = { ...(this.store.sync || {}), failures: this.consecutiveFailures, lastError: e.message };
      if (this.store.mode !== 'live') this.store.mode = 'error: ' + e.message;
    }
  }

  stop() {
    this.running = false;
  }
}

module.exports = { Poller };
