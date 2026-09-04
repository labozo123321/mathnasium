// Produces the detail payload: stats + aggregate map data (school circles,
// ZIP-area density) for a single center OR for all centers combined. Used by
// both the local server and the serverless entry point. No individual student
// locations are ever computed.

const { computeCenterDetail, placesForCenter } = require('./centerDetail');
const { todayInTz, normalizeDateString } = require('./dayStats');
const { geocodePlaces, geocodeCenters, kmBetween } = require('./geocode');
const { studentRecords, cohortSeries } = require('./cohorts');

const SCHOOL_REPORT_TTL = 10 * 60 * 1000; // heavy call - cache 10 min
const HISTORY_TTL = 6 * 60 * 60 * 1000;   // ~30s to fetch, and it only moves daily

// StudentId -> ISO start date of the hold that is active on `today`.
// If a student has several, the most recent start wins.
function activeHoldStarts(holdRows, today) {
  const map = new Map();
  for (const r of holdRows || []) {
    const start = normalizeDateString(r.StrHoldStartDt);
    const end = normalizeDateString(r.StrHoldEndDt);
    if (!start || start > today) continue;
    if (end && end < today) continue;
    const id = Number(r.StudentId);
    if (!Number.isFinite(id)) continue;
    const prev = map.get(id);
    if (!prev || start > prev) map.set(id, start);
  }
  return map;
}

// Merge several per-center details into one combined view.
// Student-weighted centroid of located places. ZIP centroids (Zippopotam)
// are reliable; school name searches occasionally land on a same-named
// school elsewhere, so the ZIP centroid is the anchor and any school more
// than MAX_SCHOOL_KM from it is treated as not located (it stays in the
// leaderboard, just not on the map).
const MAX_SCHOOL_KM = 80;
function centroid(list) {
  let w = 0; let lat = 0; let lng = 0;
  for (const p of list) {
    if (p.lat == null || p.lng == null) continue;
    w += p.count; lat += p.lat * p.count; lng += p.lng * p.count;
  }
  return w ? [lat / w, lng / w] : null;
}
// Anchor for a center: the median location of every ZIP its members live in
// (all of them, not just the ones big enough to draw). A median shrugs off
// the odd mistyped or out-of-state ZIP that would drag an average away.
function medianPoint(pts) {
  const located = pts.filter((p) => p && p.lat != null && p.lng != null);
  if (!located.length) return null;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  return [med(located.map((p) => p.lat)), med(located.map((p) => p.lng))];
}
function zipAnchor(zips, geo) {
  return medianPoint(zips.map((z) => geo.zips.get(z.zip)));
}
// No ZIPs on file (some centers don't record them): fall back to the median
// school location, which still ignores a few same-named schools elsewhere.
function sanitizePlaces(detail, anchor) {
  const a = anchor || medianPoint(detail.schools || []);
  if (a) {
    for (const p of [...(detail.schools || []), ...(detail.zips || [])]) {
      if (p.lat != null && kmBetween([p.lat, p.lng], a) > MAX_SCHOOL_KM) { p.lat = null; p.lng = null; }
    }
  }
  return a;
}

async function attachCenterPins(centers, details, hints, anchors) {
  const list = centers.map((c, i) => ({
    id: c.id, name: c.name, city: hints[i].city, state: hints[i].state, anchor: sanitizePlaces(details[i], anchors[i]),
  }));
  const res = await geocodeCenters(list);
  details.forEach((d, i) => {
    const pin = res.centers.get(centers[i].id);
    d.centerPins = pin
      ? [{ id: centers[i].id, name: centers[i].name, lat: pin.lat, lng: pin.lng, approx: !!pin.approx, members: d.memberCount || 0 }]
      : [];
  });
  return res.remaining;
}

// --- enrollment report: expiring memberships + expected monthly revenue ------
const dayDiff = (isoA, isoB) => Math.round((Date.parse(isoA + 'T00:00:00Z') - Date.parse(isoB + 'T00:00:00Z')) / 86400000);
const forCenterRows = (rows, center) => rows.filter((r) =>
  (r.CenterId != null && Number(r.CenterId) === Number(center.id))
  || (r.CenterId == null && (r.CenterName || '').trim().toLowerCase() === center.name.toLowerCase()));

const EXPIRING_DAYS = 30;
// Distinct student ids with a live enrollment at this center.
function enrolledIdsFor(rows, center) {
  const ids = new Set();
  for (const r of forCenterRows(rows, center)) if (r.StudentId != null) ids.add(Number(r.StudentId));
  return ids;
}
// Radius lists a student's enrollment more than once (a "* " flagged copy
// carries the expected amount for the report window, the plain copy the
// contract). We keep one row per student: the recurring monthly amount is
// the largest monthly figure on any of their rows; packages (not recurring)
// are counted separately since their amount is a one-time price.
const monthlyOf = (r) => Math.max(Number(r.Recurring_Monthly_Amount) || 0, Number(r.MonthlyPayment) || 0, r.Recurring ? Number(r.ExpectedMonthlyAmount) || 0 : 0);
function enrollmentExtras(rows, center, today) {
  const byStudent = new Map();
  for (const r of forCenterRows(rows, center)) {
    const key = r.StudentId ?? `${r.StudentName}|${r.EnrStartDateString}`;
    const cur = byStudent.get(key);
    if (!cur) { byStudent.set(key, { r, monthly: monthlyOf(r), pkg: !r.Recurring ? Number(r.ExpectedMonthlyAmount) || 0 : 0 }); continue; }
    cur.monthly = Math.max(cur.monthly, monthlyOf(r));
    cur.pkg = Math.max(cur.pkg, !r.Recurring ? Number(r.ExpectedMonthlyAmount) || 0 : 0);
    if (r.Recurring && !cur.r.Recurring) cur.r = r; // prefer the recurring row for dates
  }
  const mine = [...byStudent.values()];
  const expiring = [];
  let expectedMonthly = 0;
  let packageStudents = 0;
  let packageValue = 0;
  for (const { r, monthly, pkg } of mine) {
    if (monthly > 0) expectedMonthly += monthly;
    else if (pkg > 0) { packageStudents++; packageValue += pkg; }
    const end = normalizeDateString(r.EnrEndDateString);
    if (!end) continue;
    const daysLeft = dayDiff(end, today);
    if (daysLeft < 0 || daysLeft > EXPIRING_DAYS) continue;
    expiring.push({
      name: (r.StudentName || `${r.StudentFirstName || ''} ${r.StudentLastName || ''}`).trim() || '—',
      center: center.name,
      plan: r.MembershipTypeName || r.EnrollmentTypeName || null,
      endDate: end,
      daysLeft,
      recurring: !!r.Recurring,
      sessionsLeft: r.SessionsRemaining == null ? null : Number(r.SessionsRemaining),
      monthly: monthly || pkg,
    });
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);
  return {
    expiring, expectedMonthly: Math.round(expectedMonthly), enrollmentCount: mine.length,
    packageStudents, packageValue: Math.round(packageValue),
  };
}

// --- enrollment opportunities: the lead -> enrolled pipeline ----------------
function pipelineFor(rows, center, today) {
  const mine = forCenterRows(rows, center);
  const month = today.slice(0, 7);
  const lastMonthDate = new Date(Date.parse(today + 'T00:00:00Z'));
  lastMonthDate.setUTCDate(1); lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);
  // newLeads = opportunities opened in the last 30 days that are still open;
  // openTotal / stale90 show the whole backlog (Radius never archives leads
  // by itself, so most centers carry hundreds of old ones);
  // collected* = TodaysTotal on completed opportunities: the amount taken at
  // sign-up (Radius does not expose the recurring amount here).
  const out = { newLeads: 0, inProgress: 0, openTotal: 0, stale90: 0, enrolledThisMonth: 0, enrolledLastMonth: 0, collectedThisMonth: 0, collectedLastMonth: 0 };
  for (const r of mine) {
    const status = String(r.Status || '');
    if (status === 'New' || status === 'In Progress') {
      out.openTotal++;
      if (status === 'In Progress') out.inProgress++;
      const opened = normalizeDateString(r.OpenDateString || r.CreatedDateString);
      const age = opened ? dayDiff(today, opened) : null;
      if (age != null && age <= 30) out.newLeads++;
      if (age == null || age > 90) out.stale90++;
    } else if (status === 'Completed') {
      const closed = normalizeDateString(r.CloseDateString);
      if (!closed) continue;
      if (closed.startsWith(month)) { out.enrolledThisMonth++; out.collectedThisMonth += Number(r.TodaysTotal) || 0; }
      else if (closed.startsWith(lastMonth)) { out.enrolledLastMonth++; out.collectedLastMonth += Number(r.TodaysTotal) || 0; }
    }
  }
  out.collectedThisMonth = Math.round(out.collectedThisMonth);
  out.collectedLastMonth = Math.round(out.collectedLastMonth);
  return out;
}

// Completed opportunities per month for the last 12 months (count + amount
// collected at sign-up), plus how many of the last year's opportunities
// carried a parent referral - the only source field Radius fills in.
function monthKeys(today, n = 12) {
  const d = new Date(Date.parse(today + 'T00:00:00Z'));
  d.setUTCDate(1);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    keys.push(m.toISOString().slice(0, 7));
  }
  return keys;
}
function monthlyEnrollments(rows, center, today) {
  const keys = monthKeys(today);
  const byMonth = Object.fromEntries(keys.map((k) => [k, { month: k, enrolled: 0, collected: 0 }]));
  const referrals = { referred: 0, total: 0 };
  for (const r of forCenterRows(rows, center)) {
    const opened = normalizeDateString(r.OpenDateString || r.CreatedDateString);
    if (opened && dayDiff(today, opened) <= 365) {
      referrals.total++;
      if (r.ReferralAccountId) referrals.referred++;
    }
    if (String(r.Status) !== 'Completed') continue;
    const closed = normalizeDateString(r.CloseDateString);
    const k = closed && closed.slice(0, 7);
    if (k && byMonth[k]) { byMonth[k].enrolled++; byMonth[k].collected += Number(r.TodaysTotal) || 0; }
  }
  return { monthly: keys.map((k) => ({ ...byMonth[k], collected: Math.round(byMonth[k].collected) })), referrals };
}

function combineDetails(list, scopeName) {
  const sum = (k) => list.reduce((a, d) => a + (d[k] || 0), 0);
  const memberCount = sum('memberCount');
  const tenureW = list.reduce((a, d) => a + (d.avgTenureMonths || 0) * (d.memberCount || 0), 0);

  const below = [].concat(...list.map((d) => (d.belowAverage || []).map((b) => ({ ...b, center: d.name }))))
    .sort((a, b) => b.daysSinceVisit - a.daysSinceVisit)
    .slice(0, 40);
  const runningOut = [].concat(...list.map((d) => d.runningOut || []))
    .sort((a, b) => (b.isPackage - a.isPackage) || (a.sessionsLeft - b.sessionsLeft))
    .slice(0, 80);
  const holdsList = [].concat(...list.map((d) => d.holdsList || []))
    .sort((a, b) => (b.daysOnHold ?? -1) - (a.daysOnHold ?? -1))
    .slice(0, 80);

  const mergeBy = (key, items) => {
    const m = new Map();
    for (const it of items) {
      const e = m.get(it[key]) || { ...it, count: 0, lat: null, lng: null };
      e.count += it.count;
      if (it.lat != null) { e.lat = it.lat; e.lng = it.lng; }
      m.set(it[key], e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  };

  return {
    scope: scopeName,
    name: scopeName,
    enrolled: sum('enrolled'),
    active: sum('active'),
    holds: sum('holds'),
    memberCount,
    avgTenureMonths: memberCount ? tenureW / memberCount : null,
    belowAverage: below,
    runningOut,
    holdsList,
    schools: mergeBy('name', [].concat(...list.map((d) => d.schools || []))),
    zips: mergeBy('zip', [].concat(...list.map((d) => d.zips || []))),
    centerPins: [].concat(...list.map((d) => d.centerPins || [])),
    expiring: [].concat(...list.map((d) => d.expiring || [])).sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 80),
    expectedMonthly: sum('expectedMonthly'),
    enrollmentCount: sum('enrollmentCount'),
    packageStudents: sum('packageStudents'),
    packageValue: sum('packageValue'),
    pipeline: list.reduce((acc, d) => {
      for (const [k, v] of Object.entries(d.pipeline || {})) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {}),
    monthly: (list[0] && list[0].monthly ? list[0].monthly : []).map((m, i) => ({
      month: m.month,
      enrolled: list.reduce((a, d) => a + ((d.monthly || [])[i]?.enrolled || 0), 0),
      collected: list.reduce((a, d) => a + ((d.monthly || [])[i]?.collected || 0), 0),
    })),
    referrals: {
      referred: list.reduce((a, d) => a + ((d.referrals || {}).referred || 0), 0),
      total: list.reduce((a, d) => a + ((d.referrals || {}).total || 0), 0),
    },
    byCenter: list.map((d) => ({
      id: d.id, name: d.name, enrolled: d.enrolled, active: d.active, holds: d.holds,
      expectedMonthly: d.expectedMonthly || 0, packageStudents: d.packageStudents || 0, expiring: (d.expiring || []).length,
      ...(d.pipeline || {}),
    })),
  };
}

class CenterDetailProvider {
  constructor(client) {
    this.client = client;
    this.schoolReport = null;
    this.schoolReportAt = 0;
    this.inflight = null;
    this.holds = null;
    this.holdsAt = 0;
    this.holdsInflight = null;
  }

  async getSchoolReport() {
    if (this.schoolReport && Date.now() - this.schoolReportAt < SCHOOL_REPORT_TTL) return this.schoolReport;
    if (this.inflight) return this.inflight;
    this.inflight = this.client.getSchoolReport()
      .then((rows) => { this.schoolReport = rows; this.schoolReportAt = Date.now(); return rows; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // Cached optional reports: if one fails the page still renders without it.
  #cached(key, fetcher, ttl = SCHOOL_REPORT_TTL) {
    const slot = (this.slots = this.slots || {})[key] || (this.slots[key] = { rows: null, at: 0, inflight: null });
    if (slot.rows && Date.now() - slot.at < ttl) return Promise.resolve(slot.rows);
    if (slot.inflight) return slot.inflight;
    slot.inflight = fetcher()
      .then((rows) => { if (rows.length) { slot.rows = rows; slot.at = Date.now(); } return rows.length ? rows : (slot.rows || []); })
      .catch((e) => { console.warn(`[detail] ${key} unavailable:`, e.message); return slot.rows || []; })
      .finally(() => { slot.inflight = null; });
    return slot.inflight;
  }
  getEnrollments() { return this.#cached('enrollment report', () => this.client.getEnrollmentReport({ statusId: 3 })); }
  getOpportunities() { return this.#cached('enrollment opportunities', () => this.client.getEnrollmentOpportunities({ statusId: '' })); }

  // Every enrollment ever recorded, for the joined/left/tenure trends. A wide
  // date window makes the Enrollment report return the full history rather
  // than only live enrollments, which is what the cohort maths needs.
  getEnrollmentHistory() {
    return this.#cached('enrollment history', () => this.client.getEnrollmentReport({
      statusId: 3,
      start: new Date(Date.UTC(2010, 0, 1)),
      end: new Date(Date.UTC(new Date().getUTCFullYear() + 3, 11, 31)),
    }), HISTORY_TTL);
  }

  // Monthly joined / left / roster / length-of-stay series for one center
  // (or all of them). Aggregates only - no student row leaves this method.
  async cohorts(center, todayIso, months = 24) {
    if (this.client.isMock) return this.client.mockCohorts(center, todayIso, months);
    const [history, current] = await Promise.all([this.getEnrollmentHistory(), this.getEnrollments()]);
    if (!history.length) return { months: [], scope: center ? center.name : 'All centers', totals: null, unavailable: true };
    const currentIds = new Set(current.map((r) => Number(r.StudentId)).filter(Number.isFinite));
    return cohortSeries(studentRecords(history, currentIds), { center, todayIso, months });
  }

  // Holds are optional enrichment: if the report fails we still render the
  // page, just with the days-since-last-visit proxy.
  async getHolds() {
    if (this.holds && Date.now() - this.holdsAt < SCHOOL_REPORT_TTL) return this.holds;
    if (this.holdsInflight) return this.holdsInflight;
    this.holdsInflight = this.client.getHoldsReport()
      .then((rows) => { this.holds = rows; this.holdsAt = Date.now(); return rows; })
      .catch((e) => { console.warn('[detail] holds report unavailable:', e.message); return this.holds || []; })
      .finally(() => { this.holdsInflight = null; });
    return this.holdsInflight;
  }

  async detail(center) {
    if (this.client.isMock) return this.client.mockCenterDetail(center);
    const [schoolRows, attendanceRows, holdRows, enrollRows, oppRows] = await Promise.all([
      this.getSchoolReport(),
      this.client.getStudentAttendance(center.id).catch(() => []),
      this.getHolds(),
      this.getEnrollments(),
      this.getOpportunities(),
    ]);
    const { schools, zips, hint } = placesForCenter(schoolRows, center);
    const geo = await geocodePlaces(schools, zips);
    const today = todayInTz(center.tz);
    const holdStartByStudent = activeHoldStarts(holdRows, today);
    const detail = computeCenterDetail(center, schoolRows, attendanceRows, geo, { holdStartByStudent, enrolledIds: enrolledIdsFor(enrollRows, center) });
    Object.assign(detail, enrollmentExtras(enrollRows, center, today));
    detail.pipeline = pipelineFor(oppRows, center, today);
    Object.assign(detail, monthlyEnrollments(oppRows, center, today));
    const pinsPending = await attachCenterPins([center], [detail], [hint], [zipAnchor(zips, geo)]);
    detail.geocodePending = geo.remaining + pinsPending;
    detail.scope = center.name;
    return detail;
  }

  // All centers combined. Geocoding is done ONCE across the union of places
  // (globally capped), then each center is computed against that shared lookup.
  async detailAll(centers) {
    if (this.client.isMock) {
      return combineDetails(centers.map((c) => this.client.mockCenterDetail(c)), 'All centers');
    }
    const schoolRows = await this.getSchoolReport();
    const schoolMap = new Map();
    const zipMap = new Map();
    const hints = [];
    const zipLists = [];
    for (const c of centers) {
      const { schools, zips, hint } = placesForCenter(schoolRows, c);
      hints.push(hint);
      zipLists.push(zips);
      for (const s of schools) if (!schoolMap.has(s.name)) schoolMap.set(s.name, s);
      for (const z of zips) if (!zipMap.has(z.zip)) zipMap.set(z.zip, z);
    }
    const [geo, atts, holdRows, enrollRows, oppRows] = await Promise.all([
      geocodePlaces([...schoolMap.values()], [...zipMap.values()]),
      Promise.all(centers.map((c) => this.client.getStudentAttendance(c.id).catch(() => []))),
      this.getHolds(),
      this.getEnrollments(),
      this.getOpportunities(),
    ]);
    const details = centers.map((c, i) => {
      const today = todayInTz(c.tz);
      const d = computeCenterDetail(c, schoolRows, atts[i], geo, { holdStartByStudent: activeHoldStarts(holdRows, today), enrolledIds: enrolledIdsFor(enrollRows, c) });
      Object.assign(d, enrollmentExtras(enrollRows, c, today));
      d.pipeline = pipelineFor(oppRows, c, today);
      Object.assign(d, monthlyEnrollments(oppRows, c, today));
      return d;
    });
    const pinsPending = await attachCenterPins(centers, details, hints, zipLists.map((z) => zipAnchor(z, geo)));
    const combined = combineDetails(details, 'All centers');
    combined.geocodePending = geo.remaining + pinsPending;
    return combined;
  }
}

module.exports = { CenterDetailProvider, combineDetails, activeHoldStarts };
