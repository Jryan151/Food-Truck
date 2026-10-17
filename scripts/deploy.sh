#!/usr/bin/env bash
# Deploy a new version with a spare tire.
#
#   scripts/deploy.sh main          # from GitHub: fetch and switch to that branch (or tag)
#   scripts/deploy.sh               # files already copied in by hand: just snapshot-check-restart
#
# Before anything changes it saves the running code and a copy of the database. After the restart it
# checks /api/health for 30 seconds; if the new version doesn't answer, it puts the previous one back
# by itself. To go back later by hand: scripts/rollback.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/foodtruck}"
APP_NAME="${APP_NAME:-foodtruck-backend}"
PORT="${PORT:-3000}"
SNAP_DIR="${SNAP_DIR:-/var/backups/foodtruck/releases}"
KEEP=10
REF="${1:-}"
cd "$APP_DIR"
mkdir -p "$SNAP_DIR"

say() { echo "$(date '+%F %T')  $*"; }
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

# 1. The spare tire: the code that's running now, and the database as it is now.
STAMP="$(date +%F-%H%M%S)"
SNAP="$SNAP_DIR/code-$STAMP.tgz"
tar czf "$SNAP" --exclude=node_modules --exclude=uploads --exclude=limp --exclude=backups \
  --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude=.env --exclude=.git .
if command -v sqlite3 >/dev/null 2>&1 && [ -f database.sqlite ]; then
  sqlite3 database.sqlite ".backup '$SNAP_DIR/db-$STAMP.sqlite'"
fi
echo "$SNAP" > "$SNAP_DIR/LAST"
say "saved the running version: $SNAP"

# 2. The new version.
OLD_LOCK="$(sha1sum package-lock.json 2>/dev/null | cut -c1-40 || true)"
if [ -n "$REF" ]; then
  # The running files were just saved above, so anything changed by hand here (or by a rollback) is
  # replaced. .env, the database and photos are never touched: git ignores them.
  git fetch -q --tags origin
  git checkout -qf "$REF"
  if git rev-parse -q --verify "origin/$REF" >/dev/null; then git reset -q --hard "origin/$REF"; fi
  say "now on $(git rev-parse --short HEAD) ($REF)"
fi
if [ "$OLD_LOCK" != "$(sha1sum package-lock.json 2>/dev/null | cut -c1-40 || true)" ]; then
  say "packages changed: installing"
  npm ci --omit=dev
fi
# public/app.css is built before a release and kept in the repository, so nothing to build here.

# 3. The order path must pass before anything restarts (its own app copy, empty database, no email).
if ! npm test --silent; then
  say "tests failed: putting the files back. The running version was never stopped."
  tar xzf "$SNAP" -C "$APP_DIR"
  exit 1
fi

# 4. Restart without dropping requests in progress, then check it really answers.
pm2 reload "$APP_NAME" --update-env
if healthy; then
  say "deployed and healthy"
  ls -1t "$SNAP_DIR"/code-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f
  ls -1t "$SNAP_DIR"/db-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  exit 0
fi

say "the new version did not answer /api/health within 30 seconds: putting the previous one back"
"$APP_DIR/scripts/rollback.sh" "$SNAP"
exit 1
