// Mock Radius client: same interface as RadiusClient, invented data.
// Lets you run the dashboard with no credentials (npm run mock) and gives
// the UI something lively to render at any hour.

const FIRST = ['Ava', 'Liam', 'Maya', 'Noah', 'Zoe', 'Ethan', 'Aria', 'Lucas', 'Isla', 'Mason',
  'Nora', 'Kai', 'Ivy', 'Owen', 'Ruby', 'Eli', 'Luna', 'Jude', 'Elsa', 'Ryan'];
const LAST = ['Patel', 'Kim', 'Garcia', 'Nguyen', 'Smith', 'Chen', 'Lopez', 'Shah', 'Jones', 'Reddy',
  'Brown', 'Park', 'Diaz', 'Khan', 'Lee', 'Nair', 'Cruz', 'Wang', 'Bose', 'Cole'];
const TYPES = ['Monthly Sessions', 'Private Sessions Package', 'Flex Sessions'];

const CENTERS = [
  { CenterId: 3516, CenterName: 'Aurora East' },
  { CenterId: 2931, CenterName: 'Carol Stream' },
  { CenterId: 2480, CenterName: 'Glen Ellyn' },
  { CenterId: 2507, CenterName: 'Herndon' },
  { CenterId: 2644, CenterName: 'Morgan Hill' },
  { CenterId: 2788, CenterName: 'Santa Teresa' },
  { CenterId: 2843, CenterName: 'St. Charles' },
];

// deterministic per-seed pseudo-random (mulberry32 - nearby seeds diverge)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// wall-clock "now" in a center's timezone (as a plain Date for formatting)
function nowInTz(tz) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function fmtTime(d) {
  let h = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}:00 ${ampm}`;
}

// How busy a center is at a given hour (0..1): quiet mornings, after-school rush.
function busyness(hour) {
  if (hour < 10 || hour >= 20) return 0;
  if (hour < 15) return 0.15;
  if (hour < 19) return 0.9 - Math.abs(17 - hour) * 0.2;
  return 0.3;
}

class MockRadiusClient {
  constructor() {
    this.loggedIn = true;
  }

  async login() { return true; }

  async getCenters() {
    return CENTERS.map((c) => ({ id: c.CenterId, name: c.CenterName }));
  }

  #rows(center, count, isStudent) {
    const centerId = center.CenterId;
    const rand = rng(centerId * (isStudent ? 7 : 13));
    const { tzForCenter } = require('./store');
    const now = nowInTz(tzForCenter(center.CenterName));
    // MOCK_HOUR lets you preview a busy afternoon at any real time of day
    if (process.env.MOCK_HOUR) now.setHours(Number(process.env.MOCK_HOUR), now.getMinutes(), 0, 0);
    const rows = [];
    const share = busyness(now.getHours());
    for (let i = 0; i < count; i++) {
      const name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
      // whether this row shows up "today" and whether they are in right now
      const attendedToday = rand() < share * 0.9 + 0.05;
      const checkedIn = attendedToday && rand() < share * 0.7;
      const arrivalH = 15 + Math.floor(rand() * 4);
      const arrival = new Date(now);
      arrival.setHours(arrivalH, Math.floor(rand() * 60), 0, 0);
      if (arrival > now) arrival.setTime(now.getTime() - (10 + rand() * 50) * 60000);
      const lastDay = attendedToday ? now : new Date(now.getTime() - (1 + Math.floor(rand() * 9)) * 86400000);
      const base = {
        IsCheckedIn: checkedIn,
        AttendanceDateString: fmtDate(lastDay),
        ArrivalTimeString: `${fmtDate(lastDay)} ${fmtTime(arrival)}`,
        DepartureTimeString: null,
        LastActivity: checkedIn
          ? `Checked in at ${fmtTime(arrival)}`
          : `Last checked out on ${fmtDate(lastDay)} at 6:30 PM`,
      };
      if (isStudent) {
        rows.push({
          StudentID: centerId * 1000 + i,
          StudentName: name,
          PrimaryTypeName: TYPES[Math.floor(rand() * TYPES.length)],
          PrimaryCount: 1 + Math.floor(rand() * 12),
          ...base,
        });
      } else {
        rows.push({ EmployeeId: centerId * 100 + i, EmployeeName: name, ...base });
      }
    }
    return rows;
  }

  async getStudentAttendance(centerId) {
    const center = CENTERS.find((c) => c.CenterId === centerId) || { CenterId: centerId, CenterName: '' };
    return this.#rows(center, 60 + (centerId % 5) * 12, true);
  }

  async getEmployeeAttendance(centerId) {
    const center = CENTERS.find((c) => c.CenterId === centerId) || { CenterId: centerId, CenterName: '' };
    return this.#rows(center, 8, false);
  }
}

// Seed a few weeks of plausible history so the trend charts have something
// to show on first run.
function seedHistory(store) {
  const today = new Date();
  for (let back = 28; back >= 1; back--) {
    const d = new Date(today.getTime() - back * 86400000);
    const key = d.toISOString().slice(0, 10);
    if (store.history[key]) continue;
    const dow = d.getDay();
    const closed = dow === 0; // Sundays
    const day = {};
    for (const c of CENTERS) {
      const rand = rng(c.CenterId * 31 + back);
      const scale = closed ? 0 : dow === 6 ? 0.5 : 1;
      const visits = Math.round((18 + rand() * 25) * scale);
      const byHour = {};
      let left = visits;
      for (const h of [15, 16, 17, 18, 19]) {
        const n = h === 19 ? left : Math.round(left * (0.2 + rand() * 0.25));
        byHour[h] = n;
        left -= n;
        if (left <= 0) break;
      }
      day[c.CenterId] = {
        visits,
        peak: Math.round(visits * 0.4),
        staffPeak: closed ? 0 : 3 + Math.floor(rand() * 4),
        byHour,
      };
    }
    store.history[key] = day;
  }
}

module.exports = { MockRadiusClient, seedHistory };
