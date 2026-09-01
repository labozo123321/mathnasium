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

The front page always leads with the **center overview** (defaults to **All
centers**; use the top filter to focus one center):

- **Enrolled / Active / On-hold** counts, **attendance today**, and
  **average length of stay** (a running average since sign-up)
- **Attending less than usual** - enrolled students whose gap since their last
  visit is longer than the center's average, so you can follow up
- **A map of where students come from** - a circle on each school sized by how
  many of your students attend it, plus neighborhood-density circles by ZIP
  area. The map uses only **public places** (school and ZIP-area locations);
  individual student home addresses are never plotted, geocoded, or sent
  anywhere.

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
   Framework preset: **Other**. Deploy - no settings needed.
2. Open the URL. The dashboard password is **1234** (see below to change it).
3. The page then asks for your **Radius username and password** - the same
   login you use at radius.mathnasium.com. It's checked against Radius,
   remembered in that browser only, and your real centers appear. (On a new
   phone/browser you enter it once again.)

Optional extras, via **Settings → Environment Variables** in Vercel (each
takes effect after a redeploy: Deployments → ⋯ on the latest → Redeploy):

- `DASHBOARD_PASSWORD` - change the viewer password from the default
  **1234**. The page is on a public URL and shows student names, so pick
  something harder to guess.
- `RADIUS_USERNAME` / `RADIUS_PASSWORD` - store the Radius login on the
  server instead of per-browser; nobody has to type it into the page, and
  the daily history cron can record days even when nobody views.
- **Storage → Create Database → Upstash Redis** (free) - keeps trend
  history across redeploys and restarts.

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
