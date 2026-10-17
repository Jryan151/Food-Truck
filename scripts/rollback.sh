#!/usr/bin/env bash
# Put the previous version back (the spare tire saved by scripts/deploy.sh).
#
#   scripts/rollback.sh                 # the version that ran before the last deploy
#   scripts/rollback.sh <file.tgz>      # a specific saved version (ls /var/backups/foodtruck/releases)
#
# Only the code goes back. The database stays as it is: schema changes only ever add things, so older
# code runs fine on a newer database. If a deploy damaged data, the copy taken just before it is next
# to the code (db-<same time>.sqlite); see RUNBOOK.md before restoring it.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/foodtruck}"
APP_NAME="${APP_NAME:-foodtruck-backend}"
PORT="${PORT:-3000}"
SNAP_DIR="${SNAP_DIR:-/var/backups/foodtruck/releases}"
SNAP="${1:-$(cat "$SNAP_DIR/LAST" 2>/dev/null || true)}"
[ -n "$SNAP" ] && [ -f "$SNAP" ] || { echo "No saved version found (looked for $SNAP_DIR/LAST)."; exit 1; }
cd "$APP_DIR"

tar xzf "$SNAP" -C "$APP_DIR"
pm2 reload "$APP_NAME" --update-env
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "$(date '+%F %T')  rolled back to $(basename "$SNAP") and healthy"; exit 0
  fi
  sleep 1
done
echo "$(date '+%F %T')  rolled back, but /api/health still isn't answering. See RUNBOOK.md: 'Site down'."
exit 1
