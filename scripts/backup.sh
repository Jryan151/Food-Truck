#!/usr/bin/env bash
# Nightly database backup. Makes a safe copy (works while the app is running),
# keeps 14 days on this server, and copies it OFF the server with rclone.
#
# One-time setup (on the server):
#   sudo apt install sqlite3 rclone
#   rclone config            # add a remote named "offsite" (Backblaze B2, S3, Google Drive, ...)
#   chmod +x /var/www/foodtruck/scripts/backup.sh
#   crontab -e  and add:     15 3 * * * /var/www/foodtruck/scripts/backup.sh >> /var/log/foodtruck-backup.log 2>&1
#
# Test a restore at least once:  sqlite3 /tmp/restore-test.sqlite ".restore '<backup file>'"  then open it.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/foodtruck}"
DB_FILE="${DB_FILE:-$APP_DIR/database.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/foodtruck}"
REMOTE="${REMOTE:-offsite:foodtruck-backups}"   # rclone remote:path — change to yours
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F-%H%M)"
OUT="$BACKUP_DIR/db-$STAMP.sqlite"

sqlite3 "$DB_FILE" ".backup '$OUT'"
sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -q '^ok$' || { echo "$(date) backup integrity check FAILED"; exit 1; }
gzip -f "$OUT"

# Menu photos (Phase 2). Small, so a full copy each night is fine.
UPLOADS="$APP_DIR/uploads"
if [ -d "$UPLOADS" ]; then
  tar czf "$BACKUP_DIR/uploads-$STAMP.tgz" -C "$APP_DIR" uploads
  command -v rclone >/dev/null 2>&1 && rclone copy "$BACKUP_DIR/uploads-$STAMP.tgz" "$REMOTE" || true
fi

# Business tier documents (permits, inspections, insurance). Private: never in public/.
DOCS="${DOC_DIR:-$APP_DIR/documents}"
if [ -d "$DOCS" ]; then
  tar czf "$BACKUP_DIR/documents-$STAMP.tgz" -C "$(dirname "$DOCS")" "$(basename "$DOCS")"
  chmod 600 "$BACKUP_DIR/documents-$STAMP.tgz"
  command -v rclone >/dev/null 2>&1 && rclone copy "$BACKUP_DIR/documents-$STAMP.tgz" "$REMOTE" || true
fi

if command -v rclone >/dev/null 2>&1; then
  rclone copy "$OUT.gz" "$REMOTE" && echo "$(date) uploaded $OUT.gz"
  rclone delete --min-age "${KEEP_DAYS}d" "$REMOTE" || true
else
  echo "$(date) WARNING: rclone not installed — backup is only on this server"
fi

find "$BACKUP_DIR" \( -name 'db-*.sqlite.gz' -o -name 'uploads-*.tgz' -o -name 'documents-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
echo "$(date) backup ok: $OUT.gz"
