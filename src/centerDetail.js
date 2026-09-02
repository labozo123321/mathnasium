// Per-center detail: the numbers and the AGGREGATE map data behind the sketch.
// Map data is counts by school and by ZIP area - never an individual student's
// location. Pure functions; the caller supplies Radius rows + a place-geocode
// lookup.

const { normalizeDateString, todayInTz, tzForCenter } = require('./dayStats');

const STATE_BY_CENTER = {
  'Aurora East': 'IL', 'Carol Stream': 'IL', 'Glen Ellyn': 'IL', 'St. Charles': 'IL',
  Herndon: 'VA', 'Morgan Hill': 'CA', 'Santa Teresa': 'CA',
};
function stateFor(name) {
  try {
    const extra = process.env.CENTER_STATE ? JSON.parse(process.env.CENTER_STATE) : {};
    if (extra[name]) return extra[name];
  } catch (e) { /* ignore bad CENTER_STATE */ }
  return STATE_BY_CENTER[name] || '';
}

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
function monthsSince(mdY, todayIso) {
  const iso = normalizeDateString(mdY);
  if (!iso) return null;
  const d = daysBetween(todayIso, iso);
  return d >= 0 ? d / 30.44 : null;
}

const isEnrolled = (r) => r.EnrollmentStatusDescription === 'Enrolled';
const isHold = (r) => r.EnrollmentStatusDescription === 'On Hold';
// Report rows carry the center in CenterName (CenterId is often null), so match
// on name, with a CenterId fallback for safety.
const norm = (s) => String(s || '').trim().toLowerCase();
const rowMatchesCenter = (r, center) => norm(r.CenterName) === norm(center.name)
  || (r.CenterId != null && Number(r.CenterId) === Number(center.id));
const forCenter = (rows, center) => rows.filter((r) => rowMatchesCenter(r, center));
const members = (rows, center) => forCenter(rows, center).filter((r) => isEnrolled(r) || isHold(r));

const modal = (counts) => {
  let best = null; let n = -1;
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v; }
  return best;
};

// The public places to geocode for a center: each distinct school (with a
// town hint = the town most of its students live in) and each distinct ZIP.
function placesForCenter(schoolRows, center) {
  const st = stateFor(center.name);
  const mem = members(schoolRows, center);
  const schoolCity = {}; // school -> {town: count}
  const zipSet = new Set();
  for (const r of mem) {
    const school = (r.SchoolName || '').trim();
    if (school) {
      schoolCity[school] = schoolCity[school] || {};
      const town = (r.City || '').trim();
      if (town) schoolCity[school][town] = (schoolCity[school][town] || 0) + 1;
    }
    const zip = String(r.ZipCode || '').trim().slice(0, 5);
    if (/^\d{5}$/.test(zip)) zipSet.add(zip);
  }
  const schools = Object.keys(schoolCity).map((name) => ({ name, city: modal(schoolCity[name]) || '', state: st }));
  const zips = [...zipSet].map((zip) => ({ zip, state: st }));
  return { schools, zips };
}

// geo = { schools: Map<name,{lat,lng}>, zips: Map<zip,{lat,lng}> }
function computeCenterDetail(center, schoolRows, attendanceRows, geo, extras = {}) {
  const tz = center.tz || tzForCenter(center.name);
  const today = todayInTz(tz);
  const rows = forCenter(schoolRows, center);

  // sessions remaining + plan type per student (attendance roster carries it)
  const plan = new Map(); // StudentID -> { left, type, name }
  for (const a of attendanceRows || []) {
    if (a.StudentID == null) continue;
    const left = a.PrimaryCount == null ? null : Number(a.PrimaryCount);
    const prev = plan.get(a.StudentID);
    if (!prev || (left != null && (prev.left == null || left < prev.left))) {
      plan.set(a.StudentID, { left, type: a.PrimaryTypeName || null, name: a.StudentName || null });
    }
  }

  const lastSeen = new Map();
  for (const a of attendanceRows || []) {
    const iso = normalizeDateString(a.AttendanceDateString);
    if (a.StudentID != null && iso) {
      const prev = lastSeen.get(a.StudentID);
      if (!prev || iso > prev) lastSeen.set(a.StudentID, iso);
    }
  }
  const daysSince = (r) => {
    const iso = lastSeen.get(r.StudentId);
    return iso ? daysBetween(today, iso) : null;
  };

  const enrolled = rows.filter(isEnrolled);
  const holds = rows.filter(isHold);
  const mem = enrolled.concat(holds);
  const active = enrolled.filter((r) => { const d = daysSince(r); return d != null && d <= 30; });

  const tenures = mem.map((r) => monthsSince(r.sSignupDate || r.SignupDate, today)).filter((x) => x != null);
  const avgTenureMonths = tenures.length ? tenures.reduce((a, b) => a + b, 0) / tenures.length : null;

  const gaps = enrolled.map((r) => ({ r, gap: daysSince(r) })).filter((x) => x.gap != null);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b.gap, 0) / gaps.length : 0;
  const belowAverage = gaps
    .filter((x) => x.gap > avgGap)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 30)
    .map((x) => ({
      name: `${x.r.StudentFirstName || ''} ${x.r.StudentLastName || ''}`.trim(),
      school: (x.r.SchoolName || '').trim() || null,
      daysSinceVisit: x.gap,
      center: center.name,
    }));

  // --- needs-attention queues ---
  const fullName = (r) => `${r.StudentFirstName || ''} ${r.StudentLastName || ''}`.trim();

  // 1) Running out: enrolled students with <= 2 sessions left on their plan.
  //    Packages (private/flex) are the urgent renewals; monthly plans are
  //    shown too, since a low count near month-end still merits a word.
  const runningOut = enrolled
    .map((r) => ({ r, p: plan.get(r.StudentId) }))
    .filter((x) => x.p && x.p.left != null && x.p.left <= 2)
    .map((x) => ({
      name: fullName(x.r) || x.p.name || '—',
      school: (x.r.SchoolName || '').trim() || null,
      plan: x.p.type,
      isPackage: !/monthly/i.test(x.p.type || ''),
      sessionsLeft: x.p.left,
      daysSinceVisit: daysSince(x.r),
      center: center.name,
    }))
    .sort((a, b) => (b.isPackage - a.isPackage) || (a.sessionsLeft - b.sessionsLeft));

  // 2) On hold: real hold start dates when the caller supplies them,
  //    otherwise days since the student was last seen (a close proxy).
  const holdStart = extras.holdStartByStudent || new Map();
  const holdsList = holds
    .map((r) => {
      const startIso = holdStart.get(r.StudentId) || null;
      const days = startIso ? daysBetween(today, startIso) : daysSince(r);
      return {
        name: fullName(r) || '—',
        school: (r.SchoolName || '').trim() || null,
        daysOnHold: days,
        exact: !!startIso,
        center: center.name,
      };
    })
    .sort((a, b) => (b.daysOnHold ?? -1) - (a.daysOnHold ?? -1));

  // aggregate counts by school and by ZIP (never by individual)
  const schoolCounts = {};
  const zipCounts = {};
  for (const r of mem) {
    const school = (r.SchoolName || '').trim() || 'Unknown school';
    schoolCounts[school] = (schoolCounts[school] || 0) + 1;
    const zip = String(r.ZipCode || '').trim().slice(0, 5);
    if (/^\d{5}$/.test(zip)) zipCounts[zip] = (zipCounts[zip] || 0) + 1;
  }
  const schools = Object.entries(schoolCounts).map(([name, count]) => {
    const c = geo && geo.schools && geo.schools.get(name);
    return { name, count, lat: c ? c.lat : null, lng: c ? c.lng : null };
  }).sort((a, b) => b.count - a.count);
  const ZIP_MIN = 5; // a ZIP with fewer students could point at a family
  const zips = Object.entries(zipCounts).filter(([, count]) => count >= ZIP_MIN).map(([zip, count]) => {
    const c = geo && geo.zips && geo.zips.get(zip);
    return { zip, count, lat: c ? c.lat : null, lng: c ? c.lng : null };
  }).sort((a, b) => b.count - a.count);

  return {
    id: center.id,
    name: center.name,
    enrolled: enrolled.length,
    active: active.length,
    holds: holds.length,
    memberCount: mem.length,
    avgTenureMonths,
    belowAverage,
    runningOut,
    holdsList,
    schools,
    zips,
  };
}

module.exports = { computeCenterDetail, placesForCenter, stateFor };
