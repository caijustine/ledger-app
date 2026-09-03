# Ledger — operations notes

Personal reference for running the Daily Work Ledger in production.
Last verified: 2026-09-03.

## Where things stand

| Piece | Status / value |
|---|---|
| Live URL | https://ledger.cailinjustine.dev |
| Host | Railway → project `ledger_app` → environment `production` → Hobby plan |
| Code | GitHub `caijustine/ledger-app`, branch `main`; Railway auto-deploys on push |
| App port | listens on `$PORT` (Railway sets `8080`); Railway domain target port = `8080` |
| Volume | Railway volume `ledger_app-volume` mounted at `/data` (holds `ledger.db`) |
| DNS | Cloudflare: `ledger` CNAME → the `*.up.railway.app` target Railway shows for the domain (proxied) |
| Cloudflare SSL mode | currently **Full** — should be **Full (strict)** (see one-time tasks) |
| Off-site backups | **Litestream → Cloudflare R2 bucket `ledger-backups`, prefix `ledger/`** — running |
| Railway env vars | `EDIT_KEY`, `TZ=America/Denver`, `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `LITESTREAM_REGION` |

## Routine

**Daily** — just use the ledger. It autosaves. Nothing to maintain.

**Phone + laptop at once** — the older tab reloads instead of overwriting and shows a
"changed on another device" toast. Expected behaviour, not a bug.

**Once a month** — open the R2 bucket `ledger-backups` →
`ledger/generations/<id>/snapshots/` → check the newest file's timestamp is recent.
That's the "backups are still running" check.

**One-time, whenever convenient**
- Cloudflare → SSL/TLS → Overview → set mode to **Full (strict)**.
- (Optional) redirect the bare `cailinjustine.dev` / `www` somewhere — currently they go nowhere.

## If the site won't load

Work top to bottom. Full version is in `README.md` → "Troubleshooting: the site won't load".

1. **Only my machine?** Load `https://ledger.cailinjustine.dev./` — trailing dot after `.dev`.
   Browsers cache that as a separate name. If the dotted one works and the normal one doesn't,
   it's local caching, not the server:
   - `chrome://net-internals/#dns` → *Clear host cache*; then `#sockets` → *Flush socket pools*.
   - macOS: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
   - Check for a VPN / antivirus web-shield filtering the domain.
2. **Domain still wired to the app?**
   `curl -sSi https://ledger.cailinjustine.dev/api/me`
   `{"message":"Application not found"}` + header `x-railway-fallback: true` means the custom
   domain came unbound from the Railway service. Fix: Railway → service → Settings → Networking →
   re-add `ledger.cailinjustine.dev`, then point the Cloudflare CNAME at the new target it shows.
3. **App itself up?** Railway → service → Deploy Logs. Healthy boot ends with
   `[entrypoint] existing database found — starting Litestream + app` and
   `Daily Work Ledger on http://localhost:8080`.
   The red `ExperimentalWarning: SQLite` line is harmless (stderr, not an error).
4. **Always-works fallback:** Railway → Networking → *Generate Domain* gives a
   `*.up.railway.app` URL bound straight to the service, no DNS involved.

## What broke on 2026-09-02→03 (so it's recognisable next time)

Two things stacked:
1. The custom domain came unbound from the Railway service during manual dashboard changes
   (adding the volume). Railway's edge returned "Application not found" worldwide until the
   domain was re-added and the Cloudflare CNAME updated to the new target.
2. After the fix, Chrome had cached the failure against that exact hostname and kept failing
   locally while every other site worked. The trailing-dot URL bypassed the cache and cleared it.

There's no code fix for either — the mitigation is this file plus the README runbook.

## Don't

- Don't touch Railway volume / networking / service settings unless the runbook above sends you there — that's what broke it.
- Don't recreate or duplicate the Railway service — it orphans the domain and the volume.

## Recover the database from backup

Automatic: a fresh Railway deploy with an **empty** `/data` volume restores from R2 on boot
(`docker-entrypoint.sh` does this). An existing volume is left untouched.

Manual copy to your laptop:
```
brew install benbjohnson/litestream/litestream
LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=... \
litestream restore -o ./ledger.db \
  s3://ledger-backups.<r2-account-id>.r2.cloudflarestorage.com/ledger
```

JSON export (owner only, needs the key header — a plain browser visit won't work):
```
curl -H "x-edit-key: YOUR_EDIT_KEY" https://ledger.cailinjustine.dev/api/export -o ledger-backup.json
```
