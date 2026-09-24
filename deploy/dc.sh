#!/usr/bin/env bash
# docker compose for a server whose own nginx is the reverse proxy (the staging VPS). Passes both
# compose files every time, so the 127.0.0.1-only port of docker-compose.prod.host-nginx.yml can
# never be forgotten. Any docker compose arguments work:
#
#   ./deploy/dc.sh up -d --build
#   ./deploy/dc.sh ps
#   ./deploy/dc.sh logs -f api
set -euo pipefail

cd "$(dirname "$0")/.."
exec docker compose -f docker-compose.prod.yml -f docker-compose.prod.host-nginx.yml "$@"
