#!/usr/bin/env bash
# LOCAL TEST ONLY. Writes deploy/nginx/.local/api.conf: a copy of the committed server block with
# exactly two substitutions, so docker-compose.prod.local-nginx.yml tests the real file:
#
#   proxy_pass http://127.0.0.1:5100;             ->  proxy_pass http://api:5000;
#   server_name api-staging.healthhub4u.co.uk;    ->  server_name localhost;
#
# Fails if either substitution does not match exactly once, or if anything else differs.
set -euo pipefail

cd "$(dirname "$0")"
src=api-staging.healthhub4u.co.uk.conf
out=.local/api.conf
mkdir -p .local

sed -e 's|^\(\s*proxy_pass\) http://127\.0\.0\.1:5100;|\1 http://api:5000;|' \
    -e 's|^\(\s*server_name\) api-staging\.healthhub4u\.co\.uk;|\1 localhost;|' \
    "$src" > "$out"

changed="$(diff "$src" "$out" | grep -c '^>' || true)"
if [ "$changed" != 2 ] \
  || [ "$(grep -c '^\s*proxy_pass http://api:5000;$' "$out")" != 1 ] \
  || [ "$(grep -c '^\s*server_name localhost;$' "$out")" != 1 ]; then
  echo "render-local: expected exactly the two substitutions, got:" >&2
  diff "$src" "$out" >&2 || true
  exit 1
fi
echo "rendered $out (2 lines differ from $src):"
diff "$src" "$out" || true
