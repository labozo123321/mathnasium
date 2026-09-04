// Monthly student flow: who joined, who left, how long they stayed.
//
// Radius has no "churn" report, so this is derived from the full enrollment
// history (the Enrollment report over a wide date window, which returns every
// enrollment ever rather than only the current ones). Per student we keep the
// earliest enrollment start, the latest enrollment end, and Radius's own
// StudentLengthofStay figure in months.
//
//   joined in month M  - the student's FIRST enrollment started in M
//   left in month M    - they have no current enrollment and their LAST
//                        enrollment ended in M (and that date has passed)
//   active at end of M - joined on or before M, minus those who left by M
//
// The identity `everJoined - everLeft === currently enrolled` is checked
// against Radius's own current roster in the tests and holds on live data.

const { normalizeDateString } = require('./dayStats');

const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);

function addMonths(monthKey, n) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function monthRange(endMonth, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(addMonths(endMonth, -i));
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// One record per student, folded out of every enrollment row they appear in.
// `historyRows` is the wide Enrollment report; `currentIds` is the set of
// student ids with a live enrollment today.
function studentRecords(historyRows, currentIds) {
  const byStudent = new Map();
  for (const r of historyRows || []) {
    const id = Number(r.StudentId);
    if (!Number.isFinite(id)) continue;
    const start = normalizeDateString(r.EnrStartDateString);
    const end = normalizeDateString(r.EnrEndDateString);
    const rec = byStudent.get(id) || { id, first: null, last: null, months: 0, center: null, centerId: null };
    if (start && (!rec.first || start < rec.first)) rec.first = start;
    if (end && (!rec.last || end > rec.last)) {
      rec.last = end;
      rec.center = r.CenterName || rec.center;      // the center they were with most recently
      rec.centerId = r.CenterId != null ? Number(r.CenterId) : rec.centerId;
    }
    if (!rec.center) { rec.center = r.CenterName || null; rec.centerId = r.CenterId != null ? Number(r.CenterId) : null; }
    const los = Number(r.StudentLengthofStay);
    if (Number.isFinite(los)) rec.months = Math.max(rec.months, los);
    byStudent.set(id, rec);
  }
  for (const rec of byStudent.values()) rec.active = currentIds.has(rec.id);
  return [...byStudent.values()];
}

// Monthly series for one scope. `records` from studentRecords(); `center` is
// null for all centers. Returns the last `months` months up to today.
function cohortSeries(records, { center = null, todayIso, months = 24 } = {}) {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const thisMonth = monthOf(today);
  const keys = monthRange(thisMonth, months);
  const inScope = center
    ? records.filter((r) => (r.centerId != null && Number(r.centerId) === Number(center.id))
      || (r.centerId == null && (r.center || '').toLowerCase() === String(center.name).toLowerCase()))
    : records;

  const joined = {};
  const leftBy = {};
  const stays = {};
  let everJoined = 0;
  let everLeft = 0;

  for (const r of inScope) {
    if (r.first) { joined[monthOf(r.first)] = (joined[monthOf(r.first)] || 0) + 1; everJoined++; }
    // A student counts as gone only when nothing is live and the end has passed;
    // Radius carries a few end dates in the future on already-closed records.
    if (!r.active && r.last && r.last <= today) {
      const m = monthOf(r.last);
      leftBy[m] = (leftBy[m] || 0) + 1;
      everLeft++;
      if (r.months > 0) (stays[m] = stays[m] || []).push(r.months);
    }
  }

  // Headcount entering the window, so the roster line starts at the right level.
  const firstKey = keys[0];
  let active = 0;
  for (const r of inScope) {
    if (!r.first || monthOf(r.first) >= firstKey) continue;
    if (r.active || !r.last || monthOf(r.last) >= firstKey) active++;
  }

  const out = keys.map((month) => {
    const j = joined[month] || 0;
    const l = leftBy[month] || 0;
    const startedAt = active;
    active = active + j - l;
    const s = (stays[month] || []).slice().sort((a, b) => a - b);
    return {
      month,
      label: monthLabel(month),
      joined: j,
      left: l,
      net: j - l,
      active,
      // of the students on the roster at the start of the month, how many stayed
      retention: startedAt > 0 ? round1(((startedAt - l) / startedAt) * 100) : null,
      avgStay: s.length ? round1(s.reduce((a, b) => a + b, 0) / s.length) : null,
      medianStay: round1(quantile(s, 0.5)),
      p25Stay: round1(quantile(s, 0.25)),
      p75Stay: round1(quantile(s, 0.75)),
      leaverCount: s.length,
    };
  });

  return {
    months: out,
    scope: center ? center.name : 'All centers',
    totals: {
      everJoined,
      everLeft,
      currentActive: inScope.filter((r) => r.active).length,
      joined12: out.slice(-12).reduce((a, m) => a + m.joined, 0),
      left12: out.slice(-12).reduce((a, m) => a + m.left, 0),
    },
  };
}

module.exports = { studentRecords, cohortSeries, monthRange, addMonths, monthLabel, quantile };
