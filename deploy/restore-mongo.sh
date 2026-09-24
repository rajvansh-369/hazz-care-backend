#!/usr/bin/env bash
# Restores a backup written by backup-mongo.sh into the running stack's MongoDB.
#
#   deploy/restore-mongo.sh /var/backups/hajjcare/hajjcare-20260924T031500Z.archive.gz
#
# DESTRUCTIVE: every collection in the archive is dropped and replaced (mongorestore --drop).
# Accounts, sessions and purchase records created since the backup are lost. Asks first.
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
read -r -p "Type RESTORE to continue: " answer
if [ "$answer" != "RESTORE" ]; then
  echo "aborted, nothing changed"
  exit 1
fi

./deploy/dc.sh exec -T mongo mongorestore --quiet --drop --nsInclude 'hajjcare.*' --archive --gzip < "$archive"
echo "restored from $archive"
