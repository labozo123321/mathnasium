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
