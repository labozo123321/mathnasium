// Weekly owner digest: one page per week with every center's numbers, the
// call lists, and the pipeline. Rendered as HTML (viewable in the dashboard)
// and optionally emailed through Resend on Monday mornings.
//
//   RESEND_API_KEY - enables sending (https://resend.com, free tier is fine)
//   DIGEST_TO      - comma-separated recipients
//   DIGEST_FROM    - sender (default: Resend's onboarding sender; verify your
//                    own domain in Resend to use a real address)
//   DASHBOARD_URL  - link back to the dashboard (falls back to the request host)

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
const delta = (now, before) => {
  if (!before) return '';
  const d = Math.round(((now - before) / before) * 100);
  const color = d >= 0 ? '#3F8F00' : '#D42525';
  return ` <span style="color:${color};font-weight:900">${d >= 0 ? '+' : ''}${d}%</span>`;
};

// overview: service/store overview(); all: detailAll(); hours: staffHours()
function buildDigest({ overview, all, hours, dashboardUrl }) {
  const centers = overview.centers || [];
  const byCenter = new Map((all.byCenter || []).map((c) => [c.id, c]));
  const weekTotal = centers.reduce((a, c) => a + (c.weekVisits || 0), 0);
  const lastWeekTotal = centers.reduce((a, c) => a + (c.lastWeekVisits || 0), 0);
  const understaffed = centers.reduce((a, c) => a + (c.understaffedWeek || 0), 0);
  const p = all.pipeline || {};
  const lists = {
    expiring: (all.expiring || []).filter((e) => e.daysLeft <= 14).slice(0, 25),
    runningOut: (all.runningOut || []).slice(0, 20),
    dropped: (all.belowAverage || []).slice(0, 20),
  };
  const topHours = (hours || []).slice(0, 15);

  const th = (t, right) => `<th style="text-align:${right ? 'right' : 'left'};font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#777;padding:8px 10px;border-bottom:2px solid #E5E5E5">${t}</th>`;
  const td = (t, right, strong) => `<td style="text-align:${right ? 'right' : 'left'};padding:9px 10px;border-bottom:2px solid #F0F0F0;font-weight:${strong ? 900 : 700};color:#3C3C3C;font-variant-numeric:tabular-nums">${t}</td>`;
  const card = (title, body) => `<div style="border:2px solid #E5E5E5;border-bottom-width:4px;border-radius:18px;padding:18px 20px;margin:0 0 18px;background:#fff"><h2 style="margin:0 0 12px;font-size:17px;font-weight:900;color:#3C3C3C">${title}</h2>${body}</div>`;
  const stat = (label, value, sub) => `<td style="padding:8px 10px;vertical-align:top"><div style="font-size:26px;font-weight:900;color:#3C3C3C">${value}</div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#777;font-weight:900">${label}</div>${sub ? `<div style="font-size:12px;color:#4B4B4B">${sub}</div>` : ''}</td>`;

  const centersTable = `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>${th('Center')}${th('Visits this wk', 1)}${th('vs last wk', 1)}${th('Active', 1)}${th('On hold', 1)}${th('Expiring 30d', 1)}${th('New leads 30d', 1)}${th('Enrolled this mo', 1)}${th('Understaffed', 1)}${th('Recurring $/mo', 1)}</tr>${
    centers.map((c) => {
      const d = byCenter.get(c.id) || {};
      return `<tr>${td(esc(c.name), 0, 1)}${td(c.weekVisits ?? '—', 1)}${td((c.lastWeekVisits ?? '—') + delta(c.weekVisits || 0, c.lastWeekVisits || 0), 1)}${td(`${d.active ?? '—'} <span style="color:#777">(${pct(d.active, d.enrolled)})</span>`, 1)}${td(d.holds ?? '—', 1)}${td(d.expiring ?? '—', 1)}${td(`${d.newLeads ?? 0} <span style="color:#777">of ${d.openTotal ?? 0} open</span>`, 1)}${td(d.enrolledThisMonth ?? 0, 1)}${td(c.understaffedWeek ? Math.round(c.understaffedWeek / 60 * 10) / 10 + ' h' : '0', 1)}${td(money(d.expectedMonthly), 1, 1)}</tr>`;
    }).join('')}</table>`;

  const list = (rows, cols) => rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>${cols.map((c) => th(c[0], c[2])).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => td(esc(c[1](r)), c[2])).join('')}</tr>`).join('')}</table>`
    : '<p style="color:#777;margin:0">Nothing here this week.</p>';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mathnasium weekly digest</title></head>
<body style="margin:0;background:#F7F7F7;font-family:Nunito,'Segoe UI',system-ui,-apple-system,sans-serif;color:#3C3C3C">
<div style="max-width:960px;margin:0 auto;padding:24px 16px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
    <span style="display:inline-flex;width:40px;height:40px;border-radius:12px;background:#EF3E33;color:#fff;font-weight:900;font-size:22px;align-items:center;justify-content:center;box-shadow:0 4px 0 #C9271D">M</span>
    <div><div style="font-size:22px;font-weight:900">Weekly digest</div><div style="font-size:13px;color:#777;font-weight:700">${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))} · all centers</div></div>
  </div>
  ${card('This week at a glance', `<table style="width:100%;border-collapse:collapse"><tr>${stat('Visits this week', weekTotal + delta(weekTotal, lastWeekTotal), `${lastWeekTotal} same days last week`)}${stat('Enrolled', all.enrolled ?? '—', `${all.active ?? '—'} active (${pct(all.active, all.enrolled)})`)}${stat('On hold', all.holds ?? '—')}${stat('Expiring in 30 days', (all.expiring || []).length)}${stat('Monthly recurring', money(all.expectedMonthly), all.packageStudents ? `${all.packageStudents} students on packages` : '')}</tr>
  <tr>${stat('New leads (30d)', p.newLeads ?? 0, `${p.openTotal ?? 0} open in total · ${p.stale90 ?? 0} older than 90 days`)}${stat('Enrolled this month', p.enrolledThisMonth ?? 0, `${p.enrolledLastMonth ?? 0} last month · ${money(p.collectedThisMonth)} collected at sign-up`)}${stat('Understaffed', Math.round(understaffed / 60 * 10) / 10 + ' h', 'students on the floor with no or too few instructors')}${stat('Running out', (all.runningOut || []).length, '2 or fewer sessions left')}${stat('Attendance dropped', (all.belowAverage || []).length)}</tr></table>`)}
  ${card('By center', `<div style="overflow-x:auto">${centersTable}</div>`)}
  ${card('Memberships ending in the next 14 days', list(lists.expiring, [['Student', (r) => r.name], ['Center', (r) => r.center], ['Plan', (r) => (r.plan || '—') + (r.recurring ? ' (auto-renews)' : '')], ['Ends', (r) => `${r.endDate} (${r.daysLeft}d)`, 1], ['$/mo', (r) => money(r.monthly), 1]]))}
  ${card('Running out of sessions', list(lists.runningOut, [['Student', (r) => r.name], ['Center', (r) => r.center], ['Plan', (r) => r.plan || '—'], ['Left', (r) => r.sessionsLeft, 1], ['Last seen', (r) => r.daysSinceVisit == null ? '—' : r.daysSinceVisit + 'd ago', 1]]))}
  ${card('Attendance dropped', list(lists.dropped, [['Student', (r) => r.name], ['Center', (r) => r.center], ['School', (r) => r.school || '—'], ['Last seen', (r) => r.daysSinceVisit + 'd ago', 1]]))}
  ${card('Instructor hours, last 7 days', list(topHours, [['Instructor', (r) => r.name], ['Center', (r) => r.center], ['Hours', (r) => Math.round(r.minutes / 60 * 10) / 10, 1], ['Days', (r) => r.days, 1]]))}
  <p style="font-size:12px;color:#777;text-align:center">${dashboardUrl ? `<a href="${esc(dashboardUrl)}" style="color:#0F7DB8;font-weight:900">Open the dashboard</a> · ` : ''}Data from Mathnasium Radius. Typical-day and weekly numbers come from the dashboard's own history, so they get more accurate the longer it runs.</p>
</div></body></html>`;
  return { html, subject: `Mathnasium weekly digest · ${weekTotal} visits this week` };
}

function digestConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.DIGEST_TO);
}

async function sendDigest({ html, subject }) {
  if (!digestConfigured()) return { ok: false, error: 'RESEND_API_KEY / DIGEST_TO not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM || 'Mathnasium Live <onboarding@resend.dev>',
      to: process.env.DIGEST_TO.split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      html,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, id: body.id } : { ok: false, error: body.message || `Resend returned ${res.status}` };
}

module.exports = { buildDigest, sendDigest, digestConfigured };
