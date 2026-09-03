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

// Approximate real coordinates so the demo map lands near the right city.
const CENTER_GEO = {
  3516: [41.76, -88.29], 2931: [41.91, -88.14], 2480: [41.87, -88.07],
  2507: [38.97, -77.39], 2644: [37.13, -121.65], 2788: [37.23, -121.80],
  2843: [41.91, -88.31],
};
const MOCK_SCHOOLS = ['Lincoln Elementary', 'Washington Middle', 'Jefferson Elementary',
  'Roosevelt Middle', 'Kennedy Elementary', 'Madison High', 'Hamilton Elementary'];

// Instructor names are deterministic per center so today's check-ins and the
// seeded history describe the same people.
function staffName(centerId, i) {
  return `${FIRST[(centerId * 7 + i * 3) % FIRST.length]} ${LAST[(centerId * 11 + i * 5) % LAST.length]}`;
}

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
    this.isMock = true;
  }

  async login() { return true; }

  // Synthetic per-center detail (stats + aggregate map data) for demo mode.
  mockCenterDetail(center) {
    const [clat, clng] = CENTER_GEO[center.id] || [39, -98];
    const rand = rng(center.id * 101);
    const nMembers = 45 + Math.floor(rand() * 45);
    const schoolNames = MOCK_SCHOOLS.slice(0, 4 + Math.floor(rand() * 3));
    const schoolCount = {}; const zipCount = {}; const zipGeo = {};
    let holds = 0; let active = 0; const tenures = []; const belowAverage = [];
    for (let i = 0; i < nMembers; i++) {
      const school = schoolNames[Math.floor(rand() * schoolNames.length)];
      schoolCount[school] = (schoolCount[school] || 0) + 1;
      const zip = String(95000 + Math.floor(rand() * 6));
      zipCount[zip] = (zipCount[zip] || 0) + 1;
      zipGeo[zip] = [clat + (rand() - 0.5) * 0.14, clng + (rand() - 0.5) * 0.16];
      const onHold = rand() < 0.12;
      if (onHold) holds++;
      tenures.push(1 + rand() * 30);
      const days = Math.floor(rand() * 25);
      if (!onHold && days <= 12) active++;
      if (days > 10) {
        belowAverage.push({
          name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
          school, daysSinceVisit: days + 5,
        });
      }
    }
    const schoolGeo = {};
    schoolNames.forEach((s, i) => { schoolGeo[s] = [clat + (i - 2) * 0.03, clng + (i - 2) * 0.035]; });
    const mkName = () => `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    const runningOut = Array.from({ length: 4 + Math.floor(rand() * 5) }, () => {
      const isPackage = rand() < 0.6;
      return {
        name: mkName(), school: schoolNames[Math.floor(rand() * schoolNames.length)],
        plan: isPackage ? (rand() < 0.5 ? 'Private Sessions Package' : 'Flex Sessions') : 'Monthly Sessions',
        isPackage, sessionsLeft: Math.floor(rand() * 3), daysSinceVisit: Math.floor(rand() * 9), center: center.name,
      };
    }).sort((a, b) => (b.isPackage - a.isPackage) || (a.sessionsLeft - b.sessionsLeft));
    const holdsList = Array.from({ length: holds }, () => ({
      name: mkName(), school: schoolNames[Math.floor(rand() * schoolNames.length)],
      daysOnHold: 3 + Math.floor(rand() * 70), exact: false, center: center.name,
    })).sort((a, b) => b.daysOnHold - a.daysOnHold);
    return {
      id: center.id,
      name: center.name,
      enrolled: nMembers - holds,
      active,
      holds,
      memberCount: nMembers,
      avgTenureMonths: tenures.reduce((a, b) => a + b, 0) / tenures.length,
      geocodePending: 0,
      belowAverage: belowAverage.sort((a, b) => b.daysSinceVisit - a.daysSinceVisit).slice(0, 20),
      runningOut,
      holdsList,
      schools: Object.entries(schoolCount).map(([name, count]) => ({
        name, count, lat: schoolGeo[name][0], lng: schoolGeo[name][1],
      })).sort((a, b) => b.count - a.count),
      zips: Object.entries(zipCount).map(([zip, count]) => ({
        zip, count, lat: zipGeo[zip][0], lng: zipGeo[zip][1],
      })).sort((a, b) => b.count - a.count),
      centerPins: [{ id: center.id, name: center.name, lat: clat, lng: clng, approx: false, members: nMembers }],
      expiring: Array.from({ length: 4 + Math.floor(rand() * 5) }, (_, i) => {
        const daysLeft = Math.floor(rand() * 31);
        const end = new Date(Date.now() + daysLeft * 86400000).toISOString().slice(0, 10);
        return {
          name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
          center: center.name, plan: TYPES[i % TYPES.length], endDate: end, daysLeft,
          recurring: rand() < 0.5, sessionsLeft: Math.floor(rand() * 8), monthly: 250 + Math.floor(rand() * 200),
        };
      }).sort((a, b) => a.daysLeft - b.daysLeft),
      expectedMonthly: Math.round((nMembers - holds) * (280 + rand() * 80)),
      packageStudents: 3 + Math.floor(rand() * 6),
      packageValue: Math.round((3 + rand() * 6) * 640),
      pipeline: {
        newLeads: 3 + Math.floor(rand() * 12), inProgress: 2 + Math.floor(rand() * 8), openTotal: 20 + Math.floor(rand() * 60), stale90: 10 + Math.floor(rand() * 40),
        enrolledThisMonth: 2 + Math.floor(rand() * 7), enrolledLastMonth: 3 + Math.floor(rand() * 8),
        collectedThisMonth: Math.round((2 + rand() * 6) * 420), collectedLastMonth: Math.round((3 + rand() * 8) * 420),
      },
    };
  }

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
        rows.push({ EmployeeId: centerId * 100 + i, EmployeeName: staffName(centerId, i), ...base });
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
    return this.#rows(center, 14, false);
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
      const visits = Math.round((44 + rand() * 30) * scale);
      const byHour = {};
      let left = visits;
      for (const h of [15, 16, 17, 18, 19]) {
        const n = h === 19 ? left : Math.round(left * (0.2 + rand() * 0.25));
        byHour[h] = n;
        left -= n;
        if (left <= 0) break;
      }
      const staffMin = {};
      if (!closed) for (let i = 0; i < 5; i++) if (rand() < 0.8) staffMin[staffName(c.CenterId, i)] = 150 + Math.floor(rand() * 200);
      day[c.CenterId] = {
        visits,
        peak: Math.round(visits * 0.4),
        staffPeak: closed ? 0 : 3 + Math.floor(rand() * 4),
        byHour,
        understaffed: closed ? 0 : Math.floor(rand() * 60),
        staffMin,
      };
    }
    store.history[key] = day;
  }
}

module.exports = { MockRadiusClient, seedHistory };
