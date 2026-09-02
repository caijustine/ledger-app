#!/bin/sh
# Runs the app under Litestream so every write is streamed off-host.
# With LITESTREAM_BUCKET unset it just starts the app (fine for local Docker).
set -e

DB=/data/ledger.db
CFG=/etc/litestream.yml

mkdir -p /data

if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "[entrypoint] LITESTREAM_BUCKET not set — running WITHOUT off-host backup"
  exec node server.js
fi

export LITESTREAM_PATH="${LITESTREAM_PATH:-ledger}"
export LITESTREAM_REGION="${LITESTREAM_REGION:-auto}"

if [ -f "$DB" ]; then
  # Volume already has the database — never let a backup-store hiccup block startup.
  echo "[entrypoint] existing database found — starting Litestream + app"
else
  # Fresh volume: get a definitive answer from the replica before we start writing.
  # A no-op is fine (empty store); a hard error here (bad creds / unreachable) is
  # meant to crash the deploy so you notice and fix it before any data exists.
  echo "[entrypoint] no local database — restoring from replica if one exists"
  litestream restore -if-replica-exists -config "$CFG" "$DB"
fi

exec litestream replicate -config "$CFG" -exec "node server.js"
