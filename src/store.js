// In-memory live state + on-disk daily history.
//
// Radius only exposes "who is checked in right now" and each person's last
// activity, so the dashboard records its own history: every poll updates
// today's visit count, peak concurrency, and arrivals-by-hour per center,
// persisted to data/history.json so restarts don't lose the day.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Wall-clock timezone per center. Radius returns times in the center's own
// local time, so this only matters for "what date is it there right now".
const DEFAULT_TZ = {
  Herndon: 'America/New_York',
  'Aurora East': 'America/Chicago',
  'Carol Stream': 'America/Chicago',
  'Glen Ellyn': 'America/Chicago',
  'St. Charles': 'America/Chicago',
  'Morgan Hill': 'America/Los_Angeles',
  'Santa Teresa': 'America/Los_Angeles',
};

function tzForCenter(name) {
  try {
    const extra = process.env.CENTER_TZ ? JSON.parse(process.env.CENTER_TZ) : {};
    if (extra[name]) return extra[name];
  } catch (e) { /* bad CENTER_TZ JSON — fall through to defaults */ }
  return DEFAULT_TZ[name] || 'America/New_York';
}

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
}

function nowMinutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// "8/27/2026" -> "2026-08-27"
function normalizeDateString(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || '');
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// "8/27/2026 4:26:59 PM" or "3:32 PM" -> minutes since midnight, or null
function timeToMinutes(s) {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i.exec(s || '');
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

class Store {
  constructor() {
    this.centers = []; // [{id, name, tz}]
    this.live = new Map(); // centerId -> live snapshot
    this.history = this.#loadHistory();
    this.lastSync = null;
    this.mode = 'starting';
    this.errors = [];
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
    const today = todayInTz(center.tz);

    const normStudents = students.map((r) => ({
      id: r.StudentID,
      name: r.StudentName,
      checkedIn: !!r.IsCheckedIn,
      attendanceDate: normalizeDateString(r.AttendanceDateString),
      arrivalMin: timeToMinutes(r.ArrivalTimeString),
      arrival: r.ArrivalTimeString || null,
      lastActivity: r.LastActivity || null,
      enrollmentType: r.PrimaryTypeName || null,
      sessionsLeft: r.PrimaryCount ?? null,
    }));
    const normEmployees = employees.map((r) => ({
      id: r.EmployeeId,
      name: r.EmployeeName,
      checkedIn: !!r.IsCheckedIn,
      attendanceDate: normalizeDateString(r.AttendanceDateString),
      arrivalMin: timeToMinutes(r.ArrivalTimeString),
      arrival: r.ArrivalTimeString || null,
      lastActivity: r.LastActivity || null,
    }));

    const checkedIn = normStudents.filter((s) => s.checkedIn);
    const staffIn = normEmployees.filter((s) => s.checkedIn);
    const visitedToday = normStudents.filter((s) => s.attendanceDate === today);
    const nowMin = nowMinutesInTz(center.tz);

    this.live.set(centerId, {
      students: normStudents,
      employees: normEmployees,
      checkedIn: checkedIn.length,
      staffIn: staffIn.length,
      visitsToday: visitedToday.length,
      rosterCount: normStudents.length,
      inNow: checkedIn.map((s) => ({
        name: s.name,
        arrival: s.arrival,
        // only meaningful when the check-in happened today (someone left
        // checked in overnight would otherwise show a 20-hour session)
        minutes: s.attendanceDate === today && s.arrivalMin != null && nowMin >= s.arrivalMin
          ? nowMin - s.arrivalMin
          : null,
      })),
      staffNow: staffIn.map((s) => ({ name: s.name, arrival: s.arrival })),
      updatedAt: new Date().toISOString(),
      error: null,
    });

    // ---- roll today's numbers into history ----
    const day = (this.history[today] = this.history[today] || {});
    const rec = (day[centerId] = day[centerId] || { visits: 0, peak: 0, staffPeak: 0, byHour: {} });
    rec.visits = Math.max(rec.visits, visitedToday.length);
    rec.peak = Math.max(rec.peak, checkedIn.length);
    rec.staffPeak = Math.max(rec.staffPeak, staffIn.length);
    const byHour = {};
    for (const s of visitedToday) {
      if (s.arrivalMin == null) continue;
      const h = Math.floor(s.arrivalMin / 60);
      byHour[h] = (byHour[h] || 0) + 1;
    }
    // keep the richer of the two (rows disappear from "today" after midnight)
    const oldTotal = Object.values(rec.byHour).reduce((a, b) => a + b, 0);
    const newTotal = Object.values(byHour).reduce((a, b) => a + b, 0);
    if (newTotal >= oldTotal) rec.byHour = byHour;

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
    const out = [];
    const dates = Object.keys(this.history).sort().slice(-days);
    for (const date of dates) {
      const day = this.history[date];
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
}

module.exports = { Store, tzForCenter, todayInTz, timeToMinutes, normalizeDateString };
