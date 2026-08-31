# Mathnasium Live

A live dashboard for your Mathnasium centers, powered by your Radius
(radius.mathnasium.com) login. It shows, for every center you have access to:

- **Live counter** - how many students are checked in right now, per center
- **Staff on duty** - employees currently checked in
- **Visits today** - unique students who attended today, per center
- **In the centers right now** - who's in, when they arrived, time in session
- **Roster** - every student with enrollment type, sessions left, last activity
- **Trends** - daily visits and busiest hours (the app records its own history
  while it runs, since Radius only exposes the live check-in state)

Everything auto-refreshes; light and dark theme included.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
cp .env.example .env     # then edit .env with your Radius username/password
npm start
```

Open http://127.0.0.1:5014 in your browser.

Want to see it without credentials? `npm run mock` starts it with demo data.

## How it works

The server logs into Radius exactly like the browser does (login form +
session cookie) and polls two JSON endpoints per center about once a minute:

- `/Attendance/StudentAttendances_Read?centerId=…` - student check-in state
- `/EmployeeAttendance/EmployeeAttendances_Read?centerId=…` - staff check-in state

The list of centers comes from your account automatically. Because Radius
only reports the *current* state, the app writes daily rollups (visits, peak
concurrency, arrivals per hour) to `data/history.json` - the trend charts
get richer the longer the app runs. Keep it running on a machine that's on
during center hours (a spare laptop, a mini PC, etc.) for best history.

## Put it online with Vercel (free)

Running on [Vercel](https://vercel.com) means the dashboard lives at a URL
you can open from any phone or laptop, with nothing to keep running at home.

1. Sign in to Vercel with your GitHub account → **Add New… → Project** →
   import this repository (pick the branch this code is on if asked).
   Framework preset: **Other**. Don't deploy yet - add the env vars first.
2. Under **Environment Variables**, add:
   - `RADIUS_USERNAME` - your Radius username
   - `RADIUS_PASSWORD` - your Radius password
   - `DASHBOARD_PASSWORD` - a password of your choosing; anyone opening the
     URL must enter it. **Required** - the page is on a public URL and shows
     student names, so the app refuses to serve data without it.
3. Deploy. Open the URL, enter your dashboard password, done.
4. *(Recommended)* For trend history that survives redeploys: in your Vercel
   project go to **Storage → Create Database → Upstash Redis** (free tier).
   It auto-adds the env vars the app looks for; redeploy afterwards.

How the Vercel version differs from running locally:

- There is no background poller. Data is fetched from Radius when someone
  views the dashboard (shared/cached for ~25 s across viewers).
- Daily history (visits, peak, busiest hours) is reconstructed from Radius's
  own arrival/departure times, so a single evening view captures the whole
  day - and a built-in daily cron (04:30 UTC, after all centers close)
  records each day even if nobody looked.
- Without Upstash Redis, history is kept in memory only and fades on
  redeploys/cold starts; "today" always works regardless.

## Good to know

- **Your password lives only in `.env`**, which is gitignored. The dashboard
  and its API never expose it.
- The app binds to `127.0.0.1` (your machine only) by default. The dashboard
  shows student names, so think twice before exposing it on a network -
  if you must, put it behind a reverse proxy with authentication.
- The account used here is a staff-level Radius profile: it can see check-in
  and roster data. Center-management reports (enrollment pipeline, billing)
  are not visible to this profile, so they are not on the dashboard.
- If Radius changes its login flow or endpoints, `src/radiusClient.js` is
  the only file that talks to it.

## Configuration

All optional, via `.env` (see `.env.example`): `PORT`, `HOST`,
`POLL_SECONDS`, and `CENTER_TZ` to override a center's timezone for the
"today" boundary and hour buckets.
