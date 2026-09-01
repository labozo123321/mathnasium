// Produces the detail payload: stats + aggregate map data (school circles,
// ZIP-area density) for a single center OR for all centers combined. Used by
// both the local server and the serverless entry point. No individual student
// locations are ever computed.

const { computeCenterDetail, placesForCenter } = require('./centerDetail');
const { geocodePlaces } = require('./geocode');

const SCHOOL_REPORT_TTL = 10 * 60 * 1000; // heavy call - cache 10 min

// Merge several per-center details into one combined view.
function combineDetails(list, scopeName) {
  const sum = (k) => list.reduce((a, d) => a + (d[k] || 0), 0);
  const memberCount = sum('memberCount');
  const tenureW = list.reduce((a, d) => a + (d.avgTenureMonths || 0) * (d.memberCount || 0), 0);

  const below = [].concat(...list.map((d) => (d.belowAverage || []).map((b) => ({ ...b, center: d.name }))))
    .sort((a, b) => b.daysSinceVisit - a.daysSinceVisit)
    .slice(0, 40);

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
    schools: mergeBy('name', [].concat(...list.map((d) => d.schools || []))),
    zips: mergeBy('zip', [].concat(...list.map((d) => d.zips || []))),
  };
}

class CenterDetailProvider {
  constructor(client) {
    this.client = client;
    this.schoolReport = null;
    this.schoolReportAt = 0;
    this.inflight = null;
  }

  async getSchoolReport() {
    if (this.schoolReport && Date.now() - this.schoolReportAt < SCHOOL_REPORT_TTL) return this.schoolReport;
    if (this.inflight) return this.inflight;
    this.inflight = this.client.getSchoolReport()
      .then((rows) => { this.schoolReport = rows; this.schoolReportAt = Date.now(); return rows; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async detail(center) {
    if (this.client.isMock) return this.client.mockCenterDetail(center);
    const [schoolRows, attendanceRows] = await Promise.all([
      this.getSchoolReport(),
      this.client.getStudentAttendance(center.id).catch(() => []),
    ]);
    const { schools, zips } = placesForCenter(schoolRows, center);
    const geo = await geocodePlaces(schools, zips);
    const detail = computeCenterDetail(center, schoolRows, attendanceRows, geo);
    detail.geocodePending = geo.remaining;
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
    for (const c of centers) {
      const { schools, zips } = placesForCenter(schoolRows, c);
      for (const s of schools) if (!schoolMap.has(s.name)) schoolMap.set(s.name, s);
      for (const z of zips) if (!zipMap.has(z.zip)) zipMap.set(z.zip, z);
    }
    const geo = await geocodePlaces([...schoolMap.values()], [...zipMap.values()]);
    const atts = await Promise.all(centers.map((c) => this.client.getStudentAttendance(c.id).catch(() => [])));
    const details = centers.map((c, i) => computeCenterDetail(c, schoolRows, atts[i], geo));
    const combined = combineDetails(details, 'All centers');
    combined.geocodePending = geo.remaining;
    return combined;
  }
}

module.exports = { CenterDetailProvider, combineDetails };
