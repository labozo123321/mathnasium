// Produces the per-center detail payload: stats + aggregate map data
// (school circles, ZIP-area density). Used by both the local server and the
// serverless entry point. No individual student locations are ever computed.

const { computeCenterDetail, placesForCenter } = require('./centerDetail');
const { geocodePlaces } = require('./geocode');

const SCHOOL_REPORT_TTL = 10 * 60 * 1000; // heavy call - cache 10 min

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
    detail.geocodePending = geo.remaining; // places still to resolve on a later pass
    return detail;
  }
}

module.exports = { CenterDetailProvider };
