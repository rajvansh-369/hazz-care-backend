#!/usr/bin/env bash
# Restores a backup written by backup-mongo.sh into the running stack's MongoDB.
#
#   deploy/restore-mongo.sh /var/backups/hajjcare/hajjcare-20260924T031500Z.archive.gz
#
# DESTRUCTIVE: every collection in the archive is dropped and replaced (mongorestore --drop).
# Accounts, sessions and purchase records created since the backup are lost. Asks first.
#
# IT SIGNS PILGRIMS OUT. Everyone who signed in, registered or refreshed after the backup was
# taken holds a refresh token that does not exist in the restored database, so their next
# POST /auth/refresh returns 401, which ends their session (BACKEND_SPEC.md §4). With the daily
# backup that is everyone who opened the app since the last backup. docs/DEPLOY.md §9.
#
# Talks to the stack through deploy/dc.sh, the same compose file set every other command uses.
set -euo pipefail

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "usage: $0 <backup .archive.gz file>" >&2
  exit 2
fi
archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"

cd "$(dirname "$0")/.."

echo "About to restore $archive"
echo "into the MongoDB of the stack in $(pwd) (deploy/dc.sh)."
echo "Every collection in the backup is DROPPED and replaced. Changes since the backup are lost."
echo "WARNING: everyone who signed in or refreshed after this backup was taken is SIGNED OUT"
echo "(their next /auth/refresh returns 401). See docs/DEPLOY.md section 9."
read -r -p "Type RESTORE to continue: " answer
if [ "$answer" != "RESTORE" ]; then
  echo "aborted, nothing changed"
  exit 1
fi

./deploy/dc.sh exec -T mongo mongorestore --quiet --drop --nsInclude 'hajjcare.*' --archive --gzip < "$archive"
echo "restored from $archive"
