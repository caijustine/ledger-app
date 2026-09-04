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

## Deploy on Railway (Hobby plan, ~$5/mo)
The Hobby plan is what you want: services don't sleep and volumes are supported.
1. Push this folder to a GitHub repo (or use Railway's "Deploy from local" via the CLI).
2. Railway → New Project → Deploy from GitHub repo → pick it. It detects the Dockerfile.
3. Variables: add `EDIT_KEY` (your secret) and `TZ=America/Denver`.
4. Volumes: add a volume mounted at `/data` — this is the live `ledger.db`. Without it, history is wiped on every redeploy.
5. (Strongly recommended) Add the Litestream variables from **Continuous backups** below.
6. Settings → Networking → Generate Domain. That https link is the ledger.

## Deploy on Render
New → Web Service → connect the repo → Runtime: Docker. Add env vars `EDIT_KEY`, `TZ=America/Denver`,
a Disk mounted at `/data` (needs the Starter tier — free tier has no disk), and the Litestream vars below.

## Continuous backups (Litestream)
The volume at `/data` is a single point of failure. The image bundles [Litestream](https://litestream.io),
which streams every write to S3-compatible object storage and restores automatically on a fresh boot
(empty volume → pull the latest replica; existing volume → left untouched).

Create a bucket on any S3-compatible provider — **Cloudflare R2** and **Backblaze B2** both have a free tier —
then set these variables on the host:

| Variable | Example | Notes |
|---|---|---|
| `LITESTREAM_BUCKET` | `ledger-backups` | bucket name |
| `LITESTREAM_ACCESS_KEY_ID` | … | bucket API key id |
| `LITESTREAM_SECRET_ACCESS_KEY` | … | bucket API secret |
| `LITESTREAM_ENDPOINT` | `https://<acct>.r2.cloudflarestorage.com` | R2/B2/MinIO endpoint; omit for real AWS S3 |
| `LITESTREAM_REGION` | `auto` (R2) · `us-west-004` (B2) · your AWS region | optional, defaults to `auto` |
| `LITESTREAM_PATH` | `ledger` | optional path prefix inside the bucket, defaults to `ledger` |

## AI Reports

The Reports tab has two live, editable report bubbles — **Daily** and **Weekly** — written
in short, natural, boss-readable paragraphs (no bullet lists, no corporate filler; it's
told explicitly not to invent accomplishments). Claude only ever sees a data digest built
from your clients/queue/waiting/log, never anything you didn't actually log. Requires:

| Variable | Example | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | from [console.anthropic.com](https://console.anthropic.com). Without it the Update button shows a clear "not configured" message instead of failing — nothing else in the app is affected. |
| `REPORT_MODEL` | `claude-sonnet-5` | optional, this is the default |

**Daily** updates itself in the background a few seconds after you complete a task, close a
client request, resolve a waiting item, or check off an onboarding step — no need to click
anything. **Weekly** is update-on-click only (Update button). Click into either bubble's
text to edit it directly, like a chat message — once you've touched a day's draft, the
background auto-update leaves it alone until you explicitly click **Update** again (which
always overwrites with a fresh draft). Reports live in the same SQLite file as everything
else, so they're covered by the Litestream backups above with no extra setup. Export is
**Copy** (clipboard) or **Print / Save as PDF** via the browser's print dialog — no DOCX.

Leave `LITESTREAM_BUCKET` unset and the app just runs without off-host backup (fine for local Docker).

**Restore by hand** (e.g. to a new host or to inspect a backup):
```
litestream restore -config /etc/litestream.yml /data/ledger.db     # inside the container
```
Belt-and-braces: `GET /api/export` (owner only) still returns the whole ledger + every snapshot as one JSON file.

## Production configuration (known-good)
Write any change here so a broken setting can be spotted by comparison instead of guesswork.

| Thing | Value |
|---|---|
| Host | Railway, project `ledger_app`, environment `production`, Hobby plan |
| Public domain | `ledger.cailinjustine.dev` (custom domain on the Railway service) |
| DNS | Cloudflare: `ledger` CNAME → the `*.up.railway.app` target Railway shows for the domain (proxied) |
| Cloudflare SSL mode | Full (strict) — Railway serves a valid cert, so strict is safe |
| Port | app listens on `$PORT` (Railway sets `8080`); Railway domain target port = `8080` |
| Volume | Railway volume mounted at `/data` (holds `ledger.db`) |
| Env vars | `EDIT_KEY`, `TZ=America/Denver`, and the `LITESTREAM_*` set above |

If you add or re-add the custom domain in Railway it issues a **new** `*.up.railway.app` target — update the Cloudflare CNAME to match, or the domain resolves to nothing.

## Troubleshooting: the site won't load
Work top to bottom; each step tells you which layer is at fault.

1. **Is it only your machine?** Load `https://ledger.cailinjustine.dev./` — note the trailing dot after `.dev`. Browsers cache that as a separate name. If the dotted version works and the normal one doesn't, the problem is local caching, not the server:
   - `chrome://net-internals/#dns` → *Clear host cache*; then `#sockets` → *Flush socket pools*.
   - macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
   - Check whether a VPN or antivirus web-shield is filtering the domain.
2. **Is the domain still wired to the app?** `curl -sSi https://ledger.cailinjustine.dev/api/me`. A body of `{"message":"Application not found"}` with header `x-railway-fallback: true` means the custom domain came unbound from the Railway service (happens after recreating/duplicating the service or editing networking). Fix: Railway → service → Settings → Networking → re-add `ledger.cailinjustine.dev`, then point the Cloudflare CNAME at the new target it shows.
3. **Is the app itself up?** Railway → service → Deploy Logs. A healthy boot ends with `Daily Work Ledger on http://localhost:8080 (data: /data, edit key set)`. The red `ExperimentalWarning: SQLite` line is harmless — Node prints it to stderr.
4. **Fallback that always works:** Railway → Networking → *Generate Domain* gives a `*.up.railway.app` URL bound straight to the service, no DNS involved. If that works, the app is fine and the issue is DNS/domain.

## Unlocking from a new device
Open `https://your-link/?key=YOUR_EDIT_KEY` once; the key is stored in that browser and stripped from the URL.

## Customizing
The **Setup** section at the bottom of the page (owner only) edits the standing duties — rename the three email accounts there — and the tap-to-log actions. Changes save like everything else.

## API (all JSON)
Public (so a boss can open the plain link read-only):
- `GET  /api/me` — `{canEdit, today, tz}`
- `GET  /api/state` — current ledger, plus `updatedAt`
- `GET  /api/days` — list of days that have a snapshot (date + save count only)

Owner only (require header `x-edit-key`):
- `PUT  /api/state` — save; also upserts today's snapshot + an audit event.
  Send `x-base-version: <updatedAt you loaded>`; a mismatch returns **409** with the newer state instead of overwriting it.
- `GET  /api/days/:day` — that day's frozen state
- `GET  /api/events?limit=200` — audit trail, newest first
- `GET  /api/export` — full backup (ledger + every snapshot) as one JSON file
