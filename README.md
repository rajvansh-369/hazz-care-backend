# HajjCare API

The backend for the HajjCare Flutter app: email + password accounts, sessions with
long-lived refresh tokens, and email-OTP password reset. A RevenueCat webhook is planned
(Phase 2). Health data never leaves the pilgrim's device, so this service has no
health-data, profile or entitlement endpoints.

The API is a fixed contract with an app that is already shipped. Read these before
changing anything:

- **[`BACKEND_SPEC.md`](BACKEND_SPEC.md)** — the contract, derived from the client. It wins.
- **[`CLAUDE.md`](CLAUDE.md)** — how this repo implements it, and the rules that keep the
  app working (status-code landmines, error codes, token lifetimes).

## Stack

Node.js (CommonJS) · Express 4 · MongoDB via Mongoose, running as a replica set ·
Joi (config validation) · winston + morgan · Jest + Supertest + mongodb-memory-server.

## Run locally

MongoDB must run as a **replica set** — password reset and token rotation use
transactions, which a standalone `mongod` does not support. A single node is enough.

```bash
# 1. A single-node replica set: start mongod with --replSet, then initiate it once
mongod --replSet rs0 --dbpath <data-dir>
mongosh --eval "rs.initiate()"
#    More options (Atlas, troubleshooting): docs/REPLICA_SET_SETUP.md

# 2. Configuration — set MONGODB_URL and MONGODB_REPLICA_SET=rs0 to match
cp .env.example .env
#    Fill in JWT_ACCESS_SECRET, OTP_HMAC_SECRET and RC_WEBHOOK_SECRET (32+ chars each):
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Install and start
npm install
npm run dev          # or: npm start
```

The server refuses to start on a missing secret or an out-of-range value (see
`src/config/config.js`). Routes are served under `/api/v1`, so the base URL for the app is
`http://<host>:5000/api/v1`. Health probes: `GET /health` and `GET /api/v1/health/ready`.

With `EMAIL_PROVIDER=dev`, emails are written to `.dev-emails/` instead of being sent.
`NODE_ENV=production` refuses to start unless `EMAIL_PROVIDER=smtp`.

## Tests

```bash
npm test
```

Tests start their own in-memory MongoDB (a replica set where transactions are needed), so
no database has to be running. `tests/contract/` holds the tests that encode the client
contract; a change that breaks one of them breaks the app.
