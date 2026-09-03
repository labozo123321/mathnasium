// Shared normalization + per-day statistics, used by both the long-running
// local server (poller) and the serverless/Vercel entry point.
//
// Radius rows carry each person's LAST attendance (date, arrival, departure,
// checked-in flag) in the center's local wall-clock time. From one fetch we
// can therefore reconstruct the whole current day: who visited, arrivals per
// hour, and true peak concurrency (interval sweep over arrival..departure).

// Wall-clock timezone per center - only used for "what date/time is it there
// right now"; the Radius strings themselves are already center-local.
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
  } catch (e) { /* bad CENTER_TZ JSON - fall through to defaults */ }
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
  // Demo mode: MOCK_HOUR previews a busy afternoon at any real time of day
  // (the mock client stamps its check-ins with the same hour).
  if (process.env.MOCK_HOUR) return Number(process.env.MOCK_HOUR) * 60 + m;
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

function normalizeStudents(rows) {
  return rows.map((r) => ({
    id: r.StudentID,
    name: r.StudentName,
    checkedIn: !!r.IsCheckedIn,
    attendanceDate: normalizeDateString(r.AttendanceDateString),
    arrivalMin: timeToMinutes(r.ArrivalTimeString),
    departureMin: timeToMinutes(r.DepartureTimeString),
    arrival: r.ArrivalTimeString || null,
    lastActivity: r.LastActivity || null,
    enrollmentType: r.PrimaryTypeName || null,
    sessionsLeft: r.PrimaryCount ?? null,
  }));
}

function normalizeEmployees(rows) {
  return rows.map((r) => ({
    id: r.EmployeeId,
    name: r.EmployeeName,
    checkedIn: !!r.IsCheckedIn,
    attendanceDate: normalizeDateString(r.AttendanceDateString),
    arrivalMin: timeToMinutes(r.ArrivalTimeString),
    departureMin: timeToMinutes(r.DepartureTimeString),
    arrival: r.ArrivalTimeString || null,
    lastActivity: r.LastActivity || null,
  }));
}

// True peak concurrency for today's rows: +1 at arrival, -1 at departure
// (or "still here" for people currently checked in).
function peakConcurrent(rows, nowMin) {
  const events = [];
  for (const r of rows) {
    if (r.arrivalMin == null) continue;
    const end = r.checkedIn
      ? nowMin + 1
      : (r.departureMin != null && r.departureMin >= r.arrivalMin ? r.departureMin : r.arrivalMin + 60);
    events.push([r.arrivalMin, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // departures first on ties
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

// Staffing: Mathnasium runs small-group instruction, so more than about
// four students per instructor is a stretch and more than six (or students
// with nobody on the floor) is a problem.
const RATIO_OK = 4;
const RATIO_BAD = 6;
function ratioLevel(students, staff) {
  if (!students) return 'idle';
  if (!staff) return 'bad';
  const r = students / staff;
  return r <= RATIO_OK ? 'ok' : r <= RATIO_BAD ? 'warn' : 'bad';
}

// [start, end) minute intervals for today's rows.
function intervals(rows, nowMin) {
  const out = [];
  for (const r of rows) {
    if (r.arrivalMin == null) continue;
    const end = r.checkedIn
      ? nowMin
      : (r.departureMin != null && r.departureMin >= r.arrivalMin ? r.departureMin : r.arrivalMin + 60);
    if (end > r.arrivalMin) out.push([r.arrivalMin, Math.min(end, 1440)]);
  }
  return out;
}

// Minutes so far today with students on the floor and either no instructor
// checked in or more than RATIO_BAD students per instructor.
function understaffedMinutes(studentsToday, staffToday, nowMin) {
  const ds = new Int16Array(1442);
  const de = new Int16Array(1442);
  for (const [a, b] of intervals(studentsToday, nowMin)) { ds[a] += 1; ds[b] -= 1; }
  for (const [a, b] of intervals(staffToday, nowMin)) { de[a] += 1; de[b] -= 1; }
  let st = 0; let em = 0; let bad = 0;
  for (let m = 0; m < 1440; m++) {
    st += ds[m]; em += de[m];
    if (st > 0 && ratioLevel(st, em) === 'bad') bad++;
  }
  return bad;
}

// Students and instructors on the floor every 15 minutes from 9:00 up to
// now: the raw material for the staffing coverage timeline.
const COVERAGE_START = 9 * 60;
const COVERAGE_END = 21 * 60;
function coverageToday(studentsToday, staffToday, nowMin) {
  const ds = new Int16Array(1442);
  const de = new Int16Array(1442);
  for (const [a, b] of intervals(studentsToday, nowMin)) { ds[a] += 1; ds[b] -= 1; }
  for (const [a, b] of intervals(staffToday, nowMin)) { de[a] += 1; de[b] -= 1; }
  const out = [];
  let st = 0; let em = 0;
  const last = Math.min(COVERAGE_END, nowMin);
  for (let m = 0; m <= last; m++) {
    st += ds[m]; em += de[m];
    if (m >= COVERAGE_START && m % 15 === 0) out.push({ t: m, s: st, e: em });
  }
  return out;
}

// Minutes each instructor has been in today (by name).
function staffMinutesToday(staffToday, nowMin) {
  const out = {};
  for (const e of staffToday) {
    for (const [a, b] of intervals([e], nowMin)) {
      const name = e.name || `#${e.id}`;
      out[name] = (out[name] || 0) + (b - a);
    }
  }
  return out;
}

// One center's full snapshot from raw Radius rows.
function computeCenterSnapshot(center, studentRows, employeeRows) {
  const today = todayInTz(center.tz);
  const nowMin = nowMinutesInTz(center.tz);
  const students = normalizeStudents(studentRows);
  const employees = normalizeEmployees(employeeRows);

  const checkedIn = students.filter((s) => s.checkedIn);
  const staffIn = employees.filter((e) => e.checkedIn);
  const visitedToday = students.filter((s) => s.attendanceDate === today);
  const staffToday = employees.filter((e) => e.attendanceDate === today);

  const byHour = {};
  for (const s of visitedToday) {
    if (s.arrivalMin == null) continue;
    const h = Math.floor(s.arrivalMin / 60);
    byHour[h] = (byHour[h] || 0) + 1;
  }

  return {
    today,
    students,
    employees,
    checkedIn: checkedIn.length,
    staffIn: staffIn.length,
    visitsToday: visitedToday.length,
    rosterCount: students.length,
    byHour,
    peakToday: peakConcurrent(visitedToday, nowMin),
    staffPeakToday: peakConcurrent(staffToday, nowMin),
    ratioNow: staffIn.length ? Math.round((checkedIn.length / staffIn.length) * 10) / 10 : null,
    ratioLevel: ratioLevel(checkedIn.length, staffIn.length),
    understaffedToday: understaffedMinutes(visitedToday, staffToday, nowMin),
    coverageToday: coverageToday(visitedToday, staffToday, nowMin),
    staffMinutesToday: staffMinutesToday(staffToday, nowMin),
    inNow: checkedIn.map((s) => ({
      name: s.name,
      arrival: s.arrival,
      // only meaningful when the check-in happened today (someone left
      // checked in overnight would otherwise show a 20-hour session)
      minutes: s.attendanceDate === today && s.arrivalMin != null && nowMin >= s.arrivalMin
        ? nowMin - s.arrivalMin
        : null,
    })),
    staffNow: staffIn.map((e) => ({ name: e.name, arrival: e.arrival })),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  tzForCenter,
  todayInTz,
  nowMinutesInTz,
  normalizeDateString,
  timeToMinutes,
  normalizeStudents,
  normalizeEmployees,
  peakConcurrent,
  ratioLevel,
  understaffedMinutes,
  coverageToday,
  staffMinutesToday,
  computeCenterSnapshot,
};
