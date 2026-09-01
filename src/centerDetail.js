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
function computeCenterDetail(center, schoolRows, attendanceRows, geo) {
  const tz = center.tz || tzForCenter(center.name);
  const today = todayInTz(tz);
  const rows = forCenter(schoolRows, center);

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
  const zips = Object.entries(zipCounts).map(([zip, count]) => {
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
    schools,
    zips,
  };
}

module.exports = { computeCenterDetail, placesForCenter, stateFor };
