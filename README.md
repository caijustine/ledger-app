# Daily Work Ledger

Task-first ledger: a daily checklist of standing duties, tap-to-log actions, a queue of everything that lands on you (with source + timestamp), and a week view — backed by a tiny Node + SQLite server.
Every save freezes a snapshot of the day, so any past day can be reopened exactly as it was.

## Run locally
```
npm install
EDIT_KEY=pick-a-secret npm start      # http://localhost:3000
```
Open the link, click **Unlock**, enter the key once — that browser can edit from then on.
Anyone without the key sees the same page read-only. Bosses get the plain link.

## Deploy on Railway (about 5 minutes)
1. Push this folder to a GitHub repo (or use Railway's "Deploy from local" via the CLI).
2. Railway → New Project → Deploy from GitHub repo → pick it. It detects the Dockerfile.
3. Variables: add `EDIT_KEY` (your secret) and `TZ=America/Denver`.
4. Volumes: add a volume mounted at `/data` (this is where `ledger.db` lives — without it the history is wiped on redeploy).
5. Settings → Networking → Generate Domain. That https link is the ledger.

## Deploy on Render
New → Web Service → connect the repo → Runtime: Docker. Add env vars `EDIT_KEY`, `TZ=America/Denver`,
and a Disk mounted at `/data` (free tier has no disk; the Starter tier does). Render gives you the https link.

## Unlocking from a new device
Open `https://your-link/?key=YOUR_EDIT_KEY` once; the key is stored in that browser and stripped from the URL.

## Customizing
The **Setup** section at the bottom of the page (owner only) edits the standing duties — rename the three email accounts there — and the tap-to-log actions. Changes save like everything else.

## API (all JSON)
- `GET  /api/me` — `{canEdit, today, tz}`
- `GET  /api/state` — current ledger
- `PUT  /api/state` — save (header `x-edit-key`); also upserts today's snapshot + an audit event
- `GET  /api/days` — days that have a snapshot
- `GET  /api/days/:day` — that day's frozen state
- `GET  /api/events?limit=200` — audit trail, newest first
- `GET  /api/export` — full backup as JSON
# ledger-app
