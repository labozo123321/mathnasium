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
      const expired = /expires=Thu, 01-Jan-1970/i.test(line) || value === '';
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
  async getJson(path, retried = false) {
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

  // The check-in page embeds the list of centers this account can see.
  async getCenters() {
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
}

module.exports = { RadiusClient, BASE };
