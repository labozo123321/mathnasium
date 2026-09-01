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
  computeCenterSnapshot,
};
