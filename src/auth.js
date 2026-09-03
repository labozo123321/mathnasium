// Cookie-based password protection for the dashboard, plus encrypted storage
// for a Radius login the viewer typed into the page.
//
// Auth cookie: `<issuedAt>.<hmac(secret, issuedAt)>`. It carries its own
// timestamp so it expires on the server side too, and rotating
// DASHBOARD_PASSWORD invalidates every cookie already issued.

const crypto = require('crypto');

const COOKIE_NAME = 'mn_auth';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const MAX_AGE_MS = MAX_AGE * 1000;

// Secret for cookie signing and credential encryption. SESSION_SECRET is the
// right thing to set; without one we derive from the dashboard password so a
// deployment still gets per-install keys (and rotating the password rotates
// the secret, logging everyone out - which is the desired behaviour).
function secretFor(password) {
  return crypto.createHash('sha256')
    .update(process.env.SESSION_SECRET || `mn-fallback|${String(password)}`)
    .digest();
}

function sign(value, password) {
  return crypto.createHmac('sha256', secretFor(password)).update(String(value)).digest('hex');
}

function cookieValue(password) {
  const issued = Date.now();
  return `${issued}.${sign(issued, password)}`;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of ((req.headers && req.headers.cookie) || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthenticated(req, password) {
  if (!password) return true; // no password configured -> open (local mode)
  const cookie = parseCookies(req)[COOKIE_NAME];
  if (!cookie) return false;
  const dot = cookie.indexOf('.');
  if (dot < 1) return false; // pre-expiry cookie format: reject, make them log in again
  const issued = Number(cookie.slice(0, dot));
  if (!Number.isFinite(issued) || Date.now() - issued > MAX_AGE_MS || issued > Date.now() + 60000) return false;
  return timingSafeEq(cookie.slice(dot + 1), sign(issued, password));
}

function checkPassword(candidate, password) {
  return !!password && timingSafeEq(candidate || '', password);
}

function secureFlag(req) {
  return process.env.VERCEL || (req.headers && req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
}

function authCookieHeader(password, req) {
  return `${COOKIE_NAME}=${cookieValue(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secureFlag(req)}`;
}

// --- Radius credentials in a browser cookie -------------------------------
// Encrypted with AES-256-GCM under the install secret, so reading the cookie
// off the wire or out of a browser profile does not reveal the login.
function sealCredentials(obj, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretFor(password), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return `v2.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

function openCredentials(value, password) {
  if (!value || !value.startsWith('v2.')) return null; // v1 (base64) cookies are no longer honoured
  try {
    const raw = Buffer.from(value.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretFor(password), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(out);
    return parsed && parsed.u && parsed.p ? parsed : null;
  } catch (e) {
    return null; // tampered, or the secret/password changed
  }
}

// A cache key that changes when either the username OR the password changes,
// so a warm instance can never hand a cached session to a different login.
function credentialKey(username, pw) {
  return 'u:' + crypto.createHash('sha256').update(`${username} ${pw}`).digest('hex').slice(0, 32);
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

// --- Brute-force guard ----------------------------------------------------
// 8 failed attempts per IP, then a 15-minute lockout. In-memory by default;
// serverless runs many instances, so when Upstash is configured the counter
// is shared across all of them (otherwise the limit is really 8 x instances).
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;
const LOCK_SECONDS = LOCK_MS / 1000;

function upstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redis(path) {
  const u = upstash();
  if (!u) return null;
  try {
    const res = await fetch(`${u.url}/${path}`, { headers: { Authorization: `Bearer ${u.token}` } });
    if (!res.ok) return null;
    return (await res.json()).result;
  } catch (e) {
    return null; // storage down: fall back to the in-memory counter
  }
}

function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}
const rateKey = (req) => 'mathnasium:login:' + crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 24);

async function loginAllowed(req) {
  const shared = await redis(`get/${rateKey(req)}`);
  if (shared != null && Number(shared) >= MAX_ATTEMPTS) return false;
  const a = attempts.get(clientIp(req));
  return !(a && a.n >= MAX_ATTEMPTS && a.until > Date.now());
}

async function loginFailed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until < now) a.n = 0;
  a.n += 1;
  a.until = now + LOCK_MS;
  attempts.set(ip, a);
  const key = rateKey(req);
  await redis(`incr/${key}`);
  await redis(`expire/${key}/${LOCK_SECONDS}`);
}

async function loginSucceeded(req) {
  attempts.delete(clientIp(req));
  await redis(`del/${rateKey(req)}`);
}

module.exports = {
  COOKIE_NAME, cookieValue, isAuthenticated, checkPassword, authCookieHeader, readJsonBody, parseCookies,
  sealCredentials, openCredentials, credentialKey, secureFlag,
  loginAllowed, loginFailed, loginSucceeded, MAX_ATTEMPTS,
};
