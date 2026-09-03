// Client for Mathnasium Radius (radius.mathnasium.com).
// Logs in with the same form the browser uses, keeps the ASP.NET session
// cookies, and reads the JSON endpoints behind the Student/Employee
// check-in pages.

const BASE = process.env.RADIUS_BASE_URL || 'https://radius.mathnasium.com';

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFrom(res) {
    const headers = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const line of headers) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const exp = /;\s*expires=([^;]+)/i.exec(line);
      const expired = value === '' || (exp && !Number.isNaN(Date.parse(exp[1])) && Date.parse(exp[1]) < Date.now());
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}

class RadiusClient {
  constructor({ username, password, log = console } = {}) {
    this.username = username;
    this.password = password;
    this.log = log;
    this.jar = new CookieJar();
    this.loggedIn = false;
    this.loginPromise = null;
    this.centers = [];
    this.reportChain = Promise.resolve();
  }

  async fetchRaw(path, opts = {}) {
    const res = await fetch(BASE + path, {
      redirect: 'manual',
      ...opts,
      headers: {
        'User-Agent': 'Mozilla/5.0 (mathnasium-dashboard)',
        Cookie: this.jar.header(),
        ...(opts.headers || {}),
      },
    });
    this.jar.storeFrom(res);
    return res;
  }

  async login() {
    // Collapse concurrent login attempts into one.
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.#doLogin().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async #doLogin() {
    if (!this.username || !this.password) {
      throw new Error('RADIUS_USERNAME / RADIUS_PASSWORD are not set');
    }
    this.jar.clear();
    this.loggedIn = false;
    this.token = null;

    const page = await this.fetchRaw('/Account/Login');
    const html = await page.text();
    const m = html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
    if (!m) throw new Error('Radius login page did not contain a verification token');

    const body = new URLSearchParams({
      __RequestVerificationToken: m[1],
      UserName: this.username,
      Password: this.password,
    });
    const res = await this.fetchRaw('/Account/Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const authed = this.jar.cookies.has('.AspNet.ApplicationCookie');
    if (res.status !== 302 || !authed) {
      throw new Error(`Radius rejected the login (status ${res.status}). Check RADIUS_USERNAME / RADIUS_PASSWORD.`);
    }
    this.loggedIn = true;
    this.log.info?.('[radius] logged in');
    return true;
  }

  // GET a JSON endpoint, re-authenticating once if the session has expired.
  // Waits for any report flow in progress: Radius keeps one "current report"
  // per session, and a quick read landing between a report page and its
  // data call makes the report come back empty.
  async getJson(path, retried = false) {
    await this.reportChain;
    if (!this.loggedIn) await this.login();
    const res = await this.fetchRaw(path, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    const type = res.headers.get('content-type') || '';
    if (res.status === 200 && type.includes('json')) return res.json();
    if (retried) {
      throw new Error(`Radius returned ${res.status} (${type}) for ${path}`);
    }
    this.loggedIn = false;
    await this.login();
    return this.getJson(path, true);
  }

  // The check-in page embeds the list of centers this account can see. The
  // list is cached: loading that page also resets the session's "selected
  // centers" (which the reports depend on), so it is visited as rarely as
  // possible.
  async getCenters({ refresh = false } = {}) {
    if (this.centers.length && !refresh) return this.centers;
    if (!this.loggedIn) await this.login();
    const res = await this.fetchRaw('/Attendance/StudentCheckIn');
    const html = await res.text();
    const m = html.match(/globalCenterList2 = (\[[^\]]*\])/);
    if (!m) {
      if (this.centers.length) return this.centers;
      throw new Error('Could not read the center list from Radius');
    }
    this.centers = JSON.parse(m[1]).map((c) => ({ id: c.CenterId, name: c.CenterName }));
    return this.centers;
  }

  async getStudentAttendance(centerId) {
    const data = await this.getJson(`/Attendance/StudentAttendances_Read?centerId=${centerId}`);
    return data.Data || [];
  }

  async getEmployeeAttendance(centerId) {
    const data = await this.getJson(`/EmployeeAttendance/EmployeeAttendances_Read?centerId=${centerId}`);
    return data.Data || [];
  }

  // --- Kendo report grids (POST with an antiforgery token) ---

  // Fetch and cache the antiforgery token (session-scoped, reusable). Getting
  // it also drops the paired __RequestVerificationToken cookie into the jar.
  async #getToken(pagePath) {
    if (this.token) return this.token;
    const res = await this.fetchRaw(pagePath);
    const html = await res.text();
    // Report pages answer 403 once several centers are selected, but still
    // render the form (token included); only a missing token means the
    // session is really gone, and that is retried by #runReport.
    const m = html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
    if (process.env.DEBUG_RADIUS) {
      this.log.warn?.(`[radius] getToken ${pagePath}: status=${res.status} tokenFound=${!!m} cookies=[${[...this.jar.cookies.keys()].join(',')}]`);
    }
    if (!m) {
      const err = new Error(`Could not read a form token from ${pagePath} (status ${res.status})`);
      err.transient = true;
      throw err;
    }
    this.token = m[1];
    return this.token;
  }

  // POST a Kendo DataSourceRequest grid once and return all rows. Radius grids
  // ignore paging when pageSize is large, so one call returns everything.
  async #postGridOnce(path, pagePath, extra = {}) {
    const token = await this.#getToken(pagePath);
    const params = new URLSearchParams({ __RequestVerificationToken: token, sort: '', page: '1', pageSize: '20000', group: '', filter: '' });
    for (const [k, v] of Object.entries(extra)) if (v != null) params.set(k, String(v));
    const body = params.toString();
    const res = await this.fetchRaw(path, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const type = res.headers.get('content-type') || '';
    if (res.status === 200 && type.includes('json')) {
      const rows = (await res.json()).Data || [];
      if (process.env.DEBUG_RADIUS) {
        const centers = new Set(rows.map((r) => r.CenterId));
        this.log.warn?.(`[radius] ${path}: rows=${rows.length} distinctCenters=${centers.size}`);
      }
      return rows;
    }
    const err = new Error(`Radius returned ${res.status} (${type}) for ${path}`);
    err.transient = true;
    throw err;
  }

  // Run a report flow (select centers + read), re-authenticating and re-running
  // the whole flow once if the session/token has gone stale. `prepare` must
  // re-establish any per-session state (e.g. center selection) each attempt.
  // Report flows are serialized: the session holds one center selection and
  // one "current report" at a time, and interleaving two flows (or a page
  // visit) between a report page and its read yields a 403.
  async #runReport(prepare, read) {
    const run = async () => {
      if (!this.loggedIn) await this.login();
      try {
        await prepare();
        return await read();
      } catch (e) {
        if (!e.transient) throw e;
        this.log.warn?.('[radius] report retry after: ' + e.message);
        this.token = null;
        this.loggedIn = false;
        await this.login();
        await prepare();
        return read();
      }
    };
    const result = this.reportChain.then(run, run);
    this.reportChain = result.catch(() => {});
    return result;
  }

  // Reports honor the "selected centers" stored in the session, so select them
  // all before reading a report that should span every center.
  async selectAllCenters() {
    const centers = await this.getCenters();
    const ids = centers.map((c) => c.id);
    const res = await this.fetchRaw('/Menu/setGlobalMultiCenterSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ ctrIds: ids, vcIds: [] }),
    });
    if (process.env.DEBUG_RADIUS) this.log.warn?.(`[radius] selectAllCenters: status=${res.status} ids=${ids.length}`);
  }

  // Some report grids bind a JSON body and take the antiforgery token as a
  // header rather than a form field. These reads only succeed straight after
  // their own report page has been loaded in the session, so the page is
  // always fetched first (never the cached token).
  async #postJsonOnce(path, pagePath, payload) {
    this.token = null;
    const token = await this.#getToken(pagePath);
    const res = await this.fetchRaw(path, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        __RequestVerificationToken: token,
        RequestVerificationToken: token,
      },
      body: JSON.stringify({ sort: null, page: 1, pageSize: 20000, group: null, filter: null, ...payload }),
    });
    const type = res.headers.get('content-type') || '';
    if (res.status === 200 && type.includes('json')) return (await res.json()).Data || [];
    const err = new Error(`Radius returned ${res.status} (${type}) for ${path}`);
    err.transient = true;
    throw err;
  }

  // Every hold on record for the selected centers: StudentId, hold start/end
  // (StrHoldStartDt / StrHoldEndDt as M/d/yyyy), status. Callers decide
  // which holds are active today.
  async getHoldsReport() {
    const start = new Date(Date.UTC(2015, 0, 1)).toUTCString();
    const end = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 11, 31)).toUTCString();
    let ctrIds = [];
    return this.#runReport(
      async () => {
        await this.selectAllCenters();
        ctrIds = this.centers.map((c) => c.id);
      },
      () => this.#postJsonOnce('/Holds/HoldsReport_Read', '/Holds/HoldsReport', {
        delivery: null, start, end, centerId: null, holdStatus: '', ctrIds,
      }),
    );
  }

  // Every enrollment for the selected centers within a date window, for one
  // status (2 pre-enrolled, 3 enrolled, 4 on hold, 5 inactive). Rows carry
  // start/end dates, sessions remaining, membership type, expected monthly
  // amount, hold counts and length of stay.
  async getEnrollmentReport({ statusId = 3, start, end } = {}) {
    const startD = start || new Date();
    const endD = end || new Date(Date.now() + 366 * 86400000);
    let ctrIds = '';
    return this.#runReport(
      async () => { await this.selectAllCenters(); ctrIds = this.centers.map((c) => c.id).join(','); },
      () => this.#postGridOnce('/Enrollment/EnrollmentReport_Read', '/Enrollment/EnrollmentReport', {
        centerId: '0', StartDate: startD.toUTCString(), EndDate: endD.toUTCString(), statusId: String(statusId),
        membershipTypeList: '', delivery: '', schoolPartnership: '2', ctrIds,
      }),
    );
  }

  // Enrollment opportunities (the lead -> enrollment pipeline) for the
  // selected centers; statusId selects the pipeline stage.
  async getEnrollmentOpportunities({ statusId = '' } = {}) {
    let ctrIds = '';
    return this.#runReport(
      async () => { await this.selectAllCenters(); ctrIds = this.centers.map((c) => c.id).join(','); },
      () => this.#postGridOnce('/Enrollment/EnrollmentDashboard_ReadV2', '/Enrollment/EnrollmentOpportunityDashboard', {
        statusId: String(statusId), centerId: '0', ctrIds,
      }),
    );
  }

  // Per-student records: name, enrollment status, signup date, school, and the
  // home ZipCode. We use only the school name and the ZIP (for aggregate
  // counts) - never an individual street address.
  async getSchoolReport() {
    return this.#runReport(
      () => this.selectAllCenters(),
      () => this.#postGridOnce('/SchoolReport/SchoolReport_Read', '/SchoolReport'),
    );
  }
}

module.exports = { RadiusClient, BASE };
