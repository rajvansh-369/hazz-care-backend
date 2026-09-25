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
# 1. Install
npm install

# 2. Configuration
cp .env.example .env
#    Fill in JWT_ACCESS_SECRET, OTP_HMAC_SECRET and RC_WEBHOOK_SECRET (32+ chars each):
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    and point MongoDB at the dev replica set:
#    MONGODB_URL=mongodb://127.0.0.1:27018/hajjcare?replicaSet=rs0

# 3. Terminal 1 — a one-node replica set "rs0" on port 27018, data kept in .dev-data/
npm run db:dev

# 4. Terminal 2 — the API
npm run dev          # or: npm start
```

`npm run db:dev` needs no MongoDB install and leaves any other `mongod` on the machine alone.
Alternatively, run your own `mongod --replSet rs0` and `rs.initiate()` once — see
[`docs/REPLICA_SET_SETUP.md`](docs/REPLICA_SET_SETUP.md) for that and for Atlas.

The server refuses to start on a missing secret or an out-of-range value (see
`src/config/config.js`). Routes are served under `/api/v1`, so the base URL for the app is
`http://<host>:5000/api/v1`. Health probes: `GET /health` and `GET /api/v1/health/ready`.

### Indexes: run `npm run db:sync-indexes` after any index change

```bash
npm run db:sync-indexes    # uses MONGODB_URL from .env
```

Mongoose never drops or alters an index that already exists. After a schema's indexes change,
an old one (for example a unique index on `PasswordResetOtp.codeHash`, or a TTL on `expiresAt`)
survives in every existing database and keeps enforcing the old rule. This script runs
`syncIndexes()` on every model and prints each index it dropped and created. **Run it locally
after pulling an index change, and on every deploy** before the new version takes traffic.

With `EMAIL_PROVIDER=dev`, emails are written to `.dev-emails/` instead of being sent.
`NODE_ENV=production` refuses to start unless `EMAIL_PROVIDER=smtp`.

## Tests

```bash
npm test
```

Tests start their own in-memory MongoDB (a replica set where transactions are needed), so
no database has to be running. `tests/contract/` holds the tests that encode the client
contract; a change that breaks one of them breaks the app.

## Postman

`postman/` holds the collection (every endpoint, with the contract checks as tests) and the
local environment. With `docker compose up -d --build` running, import both, select
**HajjCare - Local Docker** and run the collection: each run registers a fresh pilgrim and reads
reset codes from Mailpit. From the command line:

```bash
npx -p newman newman run postman/HajjCare-LayerA.postman_collection.json \
  -e postman/HajjCare-Environment.postman_environment.json
```

## Contract check against a running server

```bash
npm run contract                                  # http://localhost:<PORT>/api/v1
OTP_EMAIL=you@gmail.com npm run contract -- https://staging.example/api/v1
```

`scripts/verify-contract.js` (and its bash twin `scripts/verify-contract.sh`) probes a live
server for every client-breaking rule in `BACKEND_SPEC.md`. It must pass before the base URL is
handed to the app developer. Against a server that sends real email, set `OTP_EMAIL` to a
mailbox you can read: every account the run registers becomes a `+contract-…` alias of it, and
section 13 asks for the reset code sent there. Against localhost the code is read from the dev
email directory, or from Mailpit when `MAILPIT_URL` is set.
