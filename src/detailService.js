// Produces the detail payload: stats + aggregate map data (school circles,
// ZIP-area density) for a single center OR for all centers combined. Used by
// both the local server and the serverless entry point. No individual student
// locations are ever computed.

const { computeCenterDetail, placesForCenter } = require('./centerDetail');
const { todayInTz, normalizeDateString } = require('./dayStats');
const { geocodePlaces, geocodeCenters, kmBetween } = require('./geocode');

const SCHOOL_REPORT_TTL = 10 * 60 * 1000; // heavy call - cache 10 min

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
    const [schoolRows, attendanceRows, holdRows] = await Promise.all([
      this.getSchoolReport(),
      this.client.getStudentAttendance(center.id).catch(() => []),
      this.getHolds(),
    ]);
    const { schools, zips, hint } = placesForCenter(schoolRows, center);
    const geo = await geocodePlaces(schools, zips);
    const holdStartByStudent = activeHoldStarts(holdRows, todayInTz(center.tz));
    const detail = computeCenterDetail(center, schoolRows, attendanceRows, geo, { holdStartByStudent });
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
    const [geo, atts, holdRows] = await Promise.all([
      geocodePlaces([...schoolMap.values()], [...zipMap.values()]),
      Promise.all(centers.map((c) => this.client.getStudentAttendance(c.id).catch(() => []))),
      this.getHolds(),
    ]);
    const details = centers.map((c, i) => computeCenterDetail(c, schoolRows, atts[i], geo, {
      holdStartByStudent: activeHoldStarts(holdRows, todayInTz(c.tz)),
    }));
    const pinsPending = await attachCenterPins(centers, details, hints, zipLists.map((z) => zipAnchor(z, geo)));
    const combined = combineDetails(details, 'All centers');
    combined.geocodePending = geo.remaining + pinsPending;
    return combined;
  }
}

module.exports = { CenterDetailProvider, combineDetails, activeHoldStarts };
