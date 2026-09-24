#!/usr/bin/env bash
# Daily MongoDB backup for the VPS stack. Run on the host, from cron:
#
#   15 3 * * * /home/deploy/hajjcare/deploy/backup-mongo.sh >> /var/log/hajjcare-backup.log 2>&1
#
# Writes $BACKUP_DIR/hajjcare-<UTC timestamp>.archive.gz (mongodump --archive --gzip), keeps the
# newest $KEEP, and exits non-zero on any failure so cron's mail / your monitoring notices.
#
#   BACKUP_DIR    default /var/backups/hajjcare
#   KEEP          default 14
#
# Talks to the stack through deploy/dc.sh, the same compose file set every other command uses.
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hajjcare}"
KEEP="${KEEP:-14}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/hajjcare-$stamp.archive.gz"
partial="$target.partial"

# Written under a temporary name and renamed only when mongodump succeeded, so a failed run never
# leaves a truncated file that looks like a backup (and never pushes a good one out of the 14).
trap 'rm -f "$partial"' EXIT
./deploy/dc.sh exec -T mongo mongodump --quiet --db hajjcare --archive --gzip > "$partial"
if [ ! -s "$partial" ]; then
  echo "backup failed: mongodump wrote nothing" >&2
  exit 1
fi
chmod 600 "$partial"
mv "$partial" "$target"
echo "$(date -u +%FT%TZ) backup written: $target ($(du -h "$target" | cut -f1))"

# Keep the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/hajjcare-*.archive.gz | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "removed old backup: $old"
done
