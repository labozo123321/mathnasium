// Cookie-based password protection for the dashboard.
// The cookie value is an HMAC derived from DASHBOARD_PASSWORD, so restarting
// or redeploying doesn't log viewers out, and the password itself is never
// stored in the browser.

const crypto = require('crypto');

const COOKIE_NAME = 'mn_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function cookieValue(password) {
  return crypto.createHmac('sha256', String(password)).update('mathnasium-dashboard-v1').digest('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthenticated(req, password) {
  if (!password) return true; // no password configured -> open (local mode)
  const cookie = parseCookies(req)[COOKIE_NAME];
  return !!cookie && timingSafeEq(cookie, cookieValue(password));
}

function checkPassword(candidate, password) {
  return !!password && timingSafeEq(candidate || '', password);
}

function authCookieHeader(password, req) {
  const secure = process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${cookieValue(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

// Read a JSON request body whether or not the platform pre-parsed it.
async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return req.body || {};
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return {}; }
}

module.exports = { COOKIE_NAME, cookieValue, isAuthenticated, checkPassword, authCookieHeader, readJsonBody, parseCookies };
