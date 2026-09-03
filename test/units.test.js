// Unit tests for the pure logic - the parts where a silent mistake would show
// up as a wrong number on the dashboard rather than an error.
// Run with `npm test` (node:test, no dependencies).

const test = require('node:test');
const assert = require('node:assert');

const {
  timeToMinutes, normalizeDateString, peakConcurrent, ratioLevel,
  understaffedMinutes, staffMinutesToday, coverageToday, normalizeStudents,
} = require('../src/dayStats');
const { mergeDayStats, mergeHistories, centerWeekStats, staffHours, trendsFromHistory } = require('../src/history');
const { activeHoldStarts } = require('../src/detailService');
const {
  sealCredentials, openCredentials, credentialKey, cookieValue, isAuthenticated, checkPassword,
} = require('../src/auth');

// --- dayStats -------------------------------------------------------------

test('timeToMinutes parses the Radius time formats', () => {
  assert.equal(timeToMinutes('3:32 PM'), 15 * 60 + 32);
  assert.equal(timeToMinutes('8/27/2026 4:26:59 PM'), 16 * 60 + 26);
  assert.equal(timeToMinutes('12:05 AM'), 5, 'midnight hour must wrap to 0, not 12');
  assert.equal(timeToMinutes('12:30 PM'), 12 * 60 + 30, 'noon must stay 12, not 24');
  assert.equal(timeToMinutes(''), null);
  assert.equal(timeToMinutes(null), null);
  assert.equal(timeToMinutes('not a time'), null);
});

test('normalizeDateString converts M/D/YYYY to ISO', () => {
  assert.equal(normalizeDateString('8/27/2026'), '2026-08-27');
  assert.equal(normalizeDateString('12/1/2026'), '2026-12-01');
  assert.equal(normalizeDateString('8/27/2026 4:26:59 PM'), '2026-08-27');
  assert.equal(normalizeDateString(''), null);
  assert.equal(normalizeDateString('27/8/2026'), '2026-27-08', 'documents current behaviour: no validation');
});

test('peakConcurrent counts the true overlap, not the total', () => {
  const at = (a, d) => ({ arrivalMin: a, departureMin: d, checkedIn: false });
  assert.equal(peakConcurrent([], 600), 0);
  // three back-to-back visits never overlap
  assert.equal(peakConcurrent([at(600, 660), at(660, 720), at(720, 780)], 800), 1);
  // three at once
  assert.equal(peakConcurrent([at(600, 700), at(610, 700), at(620, 700)], 800), 3);
  // a departure exactly at an arrival must not count as an overlap
  assert.equal(peakConcurrent([at(600, 660), at(660, 700)], 800), 1);
  // someone still checked in counts up to "now"
  assert.equal(peakConcurrent([{ arrivalMin: 600, departureMin: null, checkedIn: true }, at(650, 700)], 660), 2);
  // rows with no arrival time are ignored
  assert.equal(peakConcurrent([{ arrivalMin: null, checkedIn: true }], 600), 0);
});

test('ratioLevel matches the staffing thresholds', () => {
  assert.equal(ratioLevel(0, 0), 'idle', 'no students is idle, not bad');
  assert.equal(ratioLevel(5, 0), 'bad', 'students with nobody on the floor is bad');
  assert.equal(ratioLevel(4, 1), 'ok');
  assert.equal(ratioLevel(6, 1), 'warn');
  assert.equal(ratioLevel(7, 1), 'bad');
  assert.equal(ratioLevel(12, 2), 'warn', 'ratio is what matters, not the headcount');
});

test('understaffedMinutes only counts minutes with students present', () => {
  const student = (a, d) => ({ arrivalMin: a, departureMin: d, checkedIn: false });
  // 60 minutes of 10 students with one instructor = all bad
  assert.equal(understaffedMinutes(Array.from({ length: 10 }, () => student(600, 660)), [student(600, 660)], 800), 60);
  // same students, two instructors -> 5:1, fine
  assert.equal(understaffedMinutes(Array.from({ length: 10 }, () => student(600, 660)), [student(600, 660), student(600, 660)], 800), 0);
  // instructors present but no students -> not understaffed
  assert.equal(understaffedMinutes([], [student(600, 660)], 800), 0);
  // students with no instructor at all
  assert.equal(understaffedMinutes([student(600, 630)], [], 800), 30);
});

test('staffMinutesToday keys by employee id so same-named instructors stay apart', () => {
  const rows = [
    { id: 1, name: 'Ryan Kim', arrivalMin: 600, departureMin: 700, checkedIn: false },
    { id: 2, name: 'Ryan Kim', arrivalMin: 600, departureMin: 660, checkedIn: false },
  ];
  const out = staffMinutesToday(rows, 800);
  assert.deepEqual(Object.keys(out).sort(), ['1', '2']);
  assert.equal(out['1'].min, 100);
  assert.equal(out['2'].min, 60);
  assert.equal(out['1'].name, 'Ryan Kim');
});

test('coverageToday samples every 15 minutes up to now', () => {
  const pts = coverageToday(
    [{ arrivalMin: 600, departureMin: 700, checkedIn: false }],
    [{ arrivalMin: 540, departureMin: 700, checkedIn: false }],
    12 * 60,
  );
  assert.ok(pts.length > 0);
  assert.equal(pts[0].t, 9 * 60, 'starts at 9:00');
  assert.ok(pts.every((p) => p.t % 15 === 0));
  assert.ok(pts[pts.length - 1].t <= 12 * 60, 'never samples past now');
  const at10 = pts.find((p) => p.t === 600);
  assert.equal(at10.s, 1);
  assert.equal(at10.e, 1);
  assert.equal(pts.find((p) => p.t === 750), undefined, '12:30 is past "now" and must not be sampled');
  const atNoon = pts.find((p) => p.t === 720);
  assert.equal(atNoon.s, 0, 'students gone after departure');
  assert.equal(atNoon.e, 0, 'instructor gone too');
});

test('normalizeStudents maps the Radius column names', () => {
  const [s] = normalizeStudents([{
    StudentID: 7, StudentName: 'A B', IsCheckedIn: true,
    AttendanceDateString: '8/27/2026', ArrivalTimeString: '3:00 PM',
    PrimaryTypeName: 'Monthly Sessions', PrimaryCount: 4,
  }]);
  assert.equal(s.id, 7);
  assert.equal(s.checkedIn, true);
  assert.equal(s.attendanceDate, '2026-08-27');
  assert.equal(s.arrivalMin, 15 * 60);
  assert.equal(s.sessionsLeft, 4);
  assert.equal(normalizeStudents([{ StudentID: 1, PrimaryCount: 0 }])[0].sessionsLeft, 0, '0 sessions must not become null');
});

// --- history --------------------------------------------------------------

const snap = (over = {}) => ({
  visitsToday: 10, peakToday: 4, staffPeakToday: 2, byHour: { 15: 6, 16: 4 },
  understaffedToday: 0, staffMinutesToday: {}, ...over,
});

test('mergeDayStats keeps the highest reading of the day', () => {
  const h = {};
  mergeDayStats(h, '2026-09-01', 1, snap({ visitsToday: 10 }));
  mergeDayStats(h, '2026-09-01', 1, snap({ visitsToday: 4, byHour: { 15: 1 } }));
  assert.equal(h['2026-09-01'][1].visits, 10, 'a later, smaller reading must not lower the day');
  assert.deepEqual(h['2026-09-01'][1].byHour, { 15: 6, 16: 4 }, 'keeps the richer histogram');
});

test('mergeDayStats accumulates instructor minutes by id', () => {
  const h = {};
  mergeDayStats(h, '2026-09-01', 1, snap({ staffMinutesToday: { 9: { name: 'Ivy', min: 120 } } }));
  mergeDayStats(h, '2026-09-01', 1, snap({ staffMinutesToday: { 9: { name: 'Ivy', min: 200 } } }));
  assert.deepEqual(h['2026-09-01'][1].staffMin['9'], { name: 'Ivy', min: 200 });
});

test('mergeHistories never loses a concurrent writer\'s day', () => {
  const a = {};
  mergeDayStats(a, '2026-09-01', 1, snap({ visitsToday: 10 }));
  const b = {};
  mergeDayStats(b, '2026-09-02', 2, snap({ visitsToday: 7 }));
  const merged = mergeHistories(a, b);
  assert.equal(merged['2026-09-01'][1].visits, 10);
  assert.equal(merged['2026-09-02'][2].visits, 7);
  // and takes the larger value where both wrote the same slot
  const c = {};
  mergeDayStats(c, '2026-09-01', 1, snap({ visitsToday: 3 }));
  assert.equal(mergeHistories(a, c)['2026-09-01'][1].visits, 10);
});

test('centerWeekStats compares like-for-like spans and averages the weekday', () => {
  const h = {};
  // Wednesday 2026-09-02; put 5 visits on each of the last 8 Wednesdays
  for (let w = 1; w <= 8; w++) {
    const d = new Date(Date.UTC(2026, 8, 2) - w * 7 * 86400000).toISOString().slice(0, 10);
    mergeDayStats(h, d, 1, snap({ visitsToday: 5 }));
  }
  mergeDayStats(h, '2026-09-02', 1, snap({ visitsToday: 12 })); // today (Wed)
  mergeDayStats(h, '2026-08-31', 1, snap({ visitsToday: 4 })); // this Monday
  const s = centerWeekStats(h, 1, '2026-09-02');
  assert.equal(s.weekday, 'Wednesday');
  assert.equal(s.typicalVisits, 5, 'average of the previous 8 Wednesdays');
  assert.equal(s.weekVisits, 16, 'Mon 4 + Wed 12, Monday-to-today only');
  assert.equal(s.lastWeekVisits, 5, 'same Mon-to-Wed span a week earlier');
});

test('centerWeekStats needs two samples before it claims a typical day', () => {
  const h = {};
  mergeDayStats(h, '2026-08-26', 1, snap({ visitsToday: 5 }));
  assert.equal(centerWeekStats(h, 1, '2026-09-02').typicalVisits, null);
});

test('staffHours uses each center\'s own date window', () => {
  const h = {};
  mergeDayStats(h, '2026-09-02', 1, snap({ staffMinutesToday: { 9: { name: 'Ivy', min: 120 } } }));
  mergeDayStats(h, '2026-09-01', 2, snap({ staffMinutesToday: { 9: { name: 'Ivy', min: 60 } } }));
  const rows = staffHours(h, [
    { id: 1, name: 'East', today: '2026-09-02' },
    { id: 2, name: 'West', today: '2026-09-01' }, // still "yesterday" out west
  ], '2026-09-02', 7);
  assert.equal(rows.length, 2, 'same person at two centers stays two rows');
  const east = rows.find((r) => r.centerId === 1);
  assert.equal(east.minutes, 120);
  assert.equal(east.todayMinutes, 120);
  const west = rows.find((r) => r.centerId === 2);
  assert.equal(west.todayMinutes, 60, 'counted as today in the center\'s own timezone');
});

test('staffHours still reads the legacy name-keyed records', () => {
  const h = { '2026-09-02': { 1: { visits: 1, peak: 1, staffPeak: 1, byHour: {}, staffMin: { 'Ivy Garcia': 90 } } } };
  const [row] = staffHours(h, [{ id: 1, name: 'East', today: '2026-09-02' }], '2026-09-02', 7);
  assert.equal(row.name, 'Ivy Garcia');
  assert.equal(row.minutes, 90);
});

test('trendsFromHistory filters by center and sums across them', () => {
  const h = {};
  mergeDayStats(h, '2026-09-01', 1, snap({ visitsToday: 10 }));
  mergeDayStats(h, '2026-09-01', 2, snap({ visitsToday: 5 }));
  assert.equal(trendsFromHistory(h, 30)[0].visits, 15);
  assert.equal(trendsFromHistory(h, 30, 1)[0].visits, 10);
  assert.equal(trendsFromHistory(h, 30, '1')[0].visits, 10, 'center id may arrive as a string');
});

// --- holds ----------------------------------------------------------------

const hold = (id, start, end) => ({ StudentId: id, StrHoldStartDt: start, StrHoldEndDt: end });

test('activeHoldStarts keeps only holds covering today', () => {
  const m = activeHoldStarts([
    hold(1, '8/1/2026', null),        // open-ended, started
    hold(2, '8/1/2026', '8/20/2026'), // already ended
    hold(3, '9/20/2026', null),       // starts later
    hold(4, '8/1/2026', '9/10/2026'), // ends later
  ], '2026-09-02');
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), [1, 4]);
  assert.equal(m.get(1), '2026-08-01');
});

test('activeHoldStarts takes the most recent start for repeat holds', () => {
  const m = activeHoldStarts([hold(1, '1/5/2026', null), hold(1, '8/1/2026', null)], '2026-09-02');
  assert.equal(m.get(1), '2026-08-01');
});

test('activeHoldStarts keys by number so lookups by StudentId match', () => {
  const m = activeHoldStarts([{ StudentId: '42', StrHoldStartDt: '8/1/2026', StrHoldEndDt: null }], '2026-09-02');
  assert.equal(m.get(42), '2026-08-01');
});

// --- auth -----------------------------------------------------------------

test('sealed credentials round-trip and reject tampering', () => {
  const sealed = sealCredentials({ u: 'someone', p: 'secret' }, 'dash-pw');
  assert.ok(!sealed.includes('someone'), 'username must not be readable in the cookie');
  assert.ok(!sealed.includes('secret'), 'password must not be readable in the cookie');
  assert.deepEqual(openCredentials(sealed, 'dash-pw'), { u: 'someone', p: 'secret' });
  assert.equal(openCredentials(sealed, 'other-pw'), null, 'a different install secret must not decrypt');
  assert.equal(openCredentials(`${sealed}x`, 'dash-pw'), null, 'tampered ciphertext is rejected');
  assert.equal(openCredentials(Buffer.from('{"u":"a","p":"b"}').toString('base64'), 'dash-pw'), null,
    'the old plaintext base64 cookie format is no longer accepted');
  assert.equal(openCredentials('', 'dash-pw'), null);
});

test('credentialKey changes when either half of the login changes', () => {
  const base = credentialKey('user', 'pw');
  assert.equal(base, credentialKey('user', 'pw'));
  assert.notEqual(base, credentialKey('user', 'other'), 'a wrong password must not reuse a cached session');
  assert.notEqual(base, credentialKey('other', 'pw'));
  assert.ok(!base.includes('pw'));
});

test('the auth cookie expires and is tied to the password', () => {
  const req = (cookie) => ({ headers: { cookie: `mn_auth=${cookie}` } });
  const good = cookieValue('pw');
  assert.equal(isAuthenticated(req(good), 'pw'), true);
  assert.equal(isAuthenticated(req(good), 'rotated'), false, 'rotating the password invalidates old cookies');
  assert.equal(isAuthenticated({ headers: {} }, 'pw'), false);
  // a stale timestamp is refused even with a valid-looking signature shape
  const [, sig] = good.split('.');
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  assert.equal(isAuthenticated(req(`${old}.${sig}`), 'pw'), false);
  // the pre-expiry cookie format (bare hmac, no timestamp) is refused
  assert.equal(isAuthenticated(req(sig), 'pw'), false);
  assert.equal(isAuthenticated(req('garbage'), 'pw'), false);
});

test('checkPassword is exact and refuses an unset password', () => {
  assert.equal(checkPassword('1234', '1234'), true);
  assert.equal(checkPassword('1235', '1234'), false);
  assert.equal(checkPassword('', ''), false, 'no configured password must never authenticate');
  assert.equal(checkPassword(undefined, '1234'), false);
});
