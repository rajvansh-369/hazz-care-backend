# syntax=docker/dockerfile:1

# Debian (glibc), not Alpine: argon2 ships a prebuilt glibc binary, so nothing is
# compiled at install time.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ARG PORT=5000
ENV PORT=${PORT}
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# The scripts production needs: `npm run db:sync-indexes` on every deploy, and the
# support lookup `npm run find-purchase -- <email>`.
COPY scripts/sync-indexes.js scripts/find-purchase.js ./scripts/

# Run unprivileged. The `node` user ships with the base image.
USER node

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+(process.env.API_PREFIX||'/api/v1')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Node is PID 1 and handles SIGTERM/SIGINT itself (src/shutdown.js). Run with an
# init (`docker run --init`, compose `init: true`) to also reap stray processes.
CMD ["node", "src/index.js"]
