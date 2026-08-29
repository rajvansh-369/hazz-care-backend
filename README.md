# Node.js + MongoDB API boilerplate

A production-shaped REST API: Express in MVC layers, MongoDB via Mongoose, JWT
authentication with rotating refresh tokens, Joi validation, an API gateway in
front, and a browser console that exercises the whole thing end to end.

Everything here has been run, not just written. See
[Verification](#verification) for what was actually executed and what still
needs checking on your side.

---

## Contents

- [Quick start](#quick-start)
- [What you get](#what-you-get)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [API surface](#api-surface)
- [Response shape](#response-shape)
- [Error handling, layer by layer](#error-handling-layer-by-layer)
- [Authentication and authorization](#authentication-and-authorization)
- [The test console](#the-test-console)
- [Testing](#testing)
- [Docker](#docker)
- [Connecting a Flutter client](#connecting-a-flutter-client)
- [Verification](#verification)
- [Before you ship](#before-you-ship)

---

## Quick start

You need Node 18+ (20 LTS recommended) and a MongoDB instance.

```bash
npm install
cp .env.example .env

# Generate a real secret and paste it into .env as JWT_SECRET
openssl rand -hex 32

npm run seed        # optional: an admin, a user and three tasks
npm run dev         # API on :5000 and gateway on :8080, both with reload
```

Then open **<http://localhost:8080>** and press **Run the sequence**. Fifteen
checks should go green. If they do, your gateway, proxy, validation, auth,
ownership rules and database are all wired together correctly.

Other entry points:

| Command                           | What it does                            |
| --------------------------------- | --------------------------------------- |
| `npm start`                       | API only, on `PORT`                     |
| `npm run start:gateway`           | Gateway only, on `GATEWAY_PORT`         |
| `npm run start:all`               | Both, without reload                    |
| `npm test`                        | Full Jest suite                         |
| `npm run test:coverage`           | Suite plus a coverage report            |
| `npm run lint` / `lint:fix`       | ESLint                                  |
| `npm run format`                  | Prettier                                |
| `npm run seed`                    | Seed a development database             |
| `node src/scripts/smoke.js <url>` | Run the console's sequence from the CLI |

---

## What you get

- **MVC layering** with a genuine service layer. Controllers parse and respond;
  services hold the rules; models hold the schema. Controllers never touch
  Mongoose directly.
- **API gateway** as its own process: service registry, path-based proxying,
  a circuit breaker per upstream, request-ID propagation, aggregated health,
  and it serves the test console.
- **Authentication** with short-lived access tokens and rotating refresh
  tokens stored hashed. Replaying a spent refresh token fails.
- **Validation** on body, params and query through Joi, with field-level error
  detail the client can render next to the offending input.
- **Error handling at every layer**, funnelled into one response shape with
  stable machine-readable codes and a correlation ID.
- **Security defaults**: Helmet with a real CSP, CORS allow-list, rate limits,
  NoSQL-injection sanitising, HTTP parameter pollution guards, bcrypt hashing,
  brute-force lockout, no account enumeration.
- **OpenAPI 3.0** document plus a Swagger explorer, outside production.
- **188 tests** across unit and integration suites.
- **Docker** image, Compose stack and a GitHub Actions workflow.

---

## Project layout

```
src/
  config/          env validation, logger, database, roles, constants
  models/          User, Token, Task + toJSON and paginate plugins
  services/        auth, token, user, task, health, email
  controllers/     thin: parse, delegate, respond
  routes/v1/       auth, users, tasks, health, docs
  middlewares/     requestId, auth, validate, error, rateLimiter
  validations/     Joi schemas, one file per resource
  gateway/         proxy, service registry, circuit breaker
  docs/            the OpenAPI document
  scripts/         seed.js, smoke.js
  utils/           ApiError, ApiResponse, catchAsync, pick, httpStatus
  app.js           the Express app (no listening)
  index.js         bootstrap, graceful shutdown
public/            the test console
tests/
  unit/            6 suites
  integration/     5 suites, real HTTP through supertest
  fixtures/        users, tokens, tasks
```

`app.js` builds the app but never listens. `index.js` owns the process. That
split is what lets the integration tests drive the real app in-process.

---

## Architecture

```
   Browser / Flutter client
             |
             v
   ┌───────────────────────┐   :8080
   │      API gateway      │   helmet, cors, rate limit,
   │  registry + breaker   │   request-id, static console
   └───────────┬───────────┘
               │  proxies /api/v1/*
               v
   ┌───────────────────────┐   :5000
   │     core service      │
   │  routes → validate →  │
   │  auth → controller →  │
   │  service → model      │
   └───────────┬───────────┘
               v
          ┌─────────┐
          │ MongoDB │
          └─────────┘
```

The gateway deliberately mounts **no body parser**. Bodies stream straight
through to the upstream, so nothing is buffered or re-serialised in transit.

Each upstream sits behind a circuit breaker. After a threshold of consecutive
failures the circuit opens and the gateway fails fast with `503
SERVICE_UNAVAILABLE` instead of piling requests onto a service that is already
struggling. It half-opens after a cooldown and closes on the first success.

Adding a second service is a registry entry — see `src/gateway/registry.js`.
This is the seam that lets the single service split into several later without
clients noticing.

---

## Configuration

Every variable is validated by Joi at startup in `src/config/config.js`. A
missing or malformed value stops the process immediately with a readable
message, rather than surfacing as a confusing failure hours later.

| Variable                        | Default                 | Notes                                                |
| ------------------------------- | ----------------------- | ---------------------------------------------------- |
| `NODE_ENV`                      | `development`           | `production` disables docs and stack traces          |
| `PORT`                          | `5000`                  | Core service                                         |
| `GATEWAY_PORT`                  | `8080`                  | Gateway                                              |
| `API_PREFIX`                    | `/api/v1`               | Mount point for all routes                           |
| `MONGODB_URL`                   | —                       | **Required**                                         |
| `MONGODB_AUTO_INDEX`            | `true`                  | Turn off in production; build indexes by migration   |
| `JWT_SECRET`                    | —                       | **Required**, minimum 32 characters                  |
| `JWT_ACCESS_EXPIRATION_MINUTES` | `15`                    |                                                      |
| `JWT_REFRESH_EXPIRATION_DAYS`   | `30`                    |                                                      |
| `JWT_ISSUER` / `JWT_AUDIENCE`   |                         | Both are verified, not just signed                   |
| `BCRYPT_SALT_ROUNDS`            | `12`                    |                                                      |
| `LOGIN_MAX_ATTEMPTS`            | `5`                     | Then a lockout                                       |
| `LOGIN_LOCK_MINUTES`            | `15`                    |                                                      |
| `TRUST_PROXY`                   | `1`                     | Must be right or rate limiting is trivially bypassed |
| `BODY_LIMIT`                    | `100kb`                 |                                                      |
| `RATE_LIMIT_MAX`                | `300`                   | Per window, general traffic                          |
| `AUTH_RATE_LIMIT_MAX`           | `20`                    | Per window, credential endpoints                     |
| `CORS_ORIGINS`                  | `*`                     | Comma-separated allow-list in production             |
| `CORE_SERVICE_URL`              | `http://127.0.0.1:5000` | What the gateway proxies to                          |
| `GATEWAY_PROXY_TIMEOUT_MS`      | `30000`                 |                                                      |

`TRUST_PROXY` deserves a second look. Behind one load balancer, `1` is right.
Set it too high and clients can spoof `X-Forwarded-For` and slip the rate
limiter; set it too low behind a proxy and every client shares one bucket.

---

## API surface

All paths are relative to `API_PREFIX` (`/api/v1` by default).

**Authentication**

| Method | Path                    | Auth          | Purpose                                 |
| ------ | ----------------------- | ------------- | --------------------------------------- |
| POST   | `/auth/register`        | —             | Create an account, receive a token pair |
| POST   | `/auth/login`           | —             | Exchange credentials for a token pair   |
| POST   | `/auth/refresh-tokens`  | refresh token | Rotate into a new pair                  |
| POST   | `/auth/logout`          | refresh token | Revoke one session                      |
| POST   | `/auth/logout-all`      | access token  | Revoke every session                    |
| POST   | `/auth/forgot-password` | —             | Issue a reset token                     |
| POST   | `/auth/reset-password`  | reset token   | Set a new password                      |
| POST   | `/auth/change-password` | access token  | Change it while signed in               |
| POST   | `/auth/verify-email`    | verify token  | Mark the address verified               |
| GET    | `/auth/me`              | access token  | The caller and their rights             |

**Users**

| Method         | Path             | Required right            |
| -------------- | ---------------- | ------------------------- |
| GET / PATCH    | `/users/me`      | any signed-in user        |
| POST           | `/users`         | `users:write`             |
| GET            | `/users`         | `users:read`              |
| GET            | `/users/:userId` | `users:read`, or yourself |
| PATCH / DELETE | `/users/:userId` | `users:write`             |

**Tasks** — all require a signed-in user; records are scoped to the owner.

| Method               | Path             |
| -------------------- | ---------------- |
| POST / GET           | `/tasks`         |
| GET                  | `/tasks/stats`   |
| GET / PATCH / DELETE | `/tasks/:taskId` |

**Health and docs**

`/health`, `/health/live`, `/health/ready` (checks MongoDB), `/docs`,
`/docs/openapi.json`. On the gateway: `/gateway/health`,
`/gateway/health/services`, `/gateway/routes`.

`/health/live` answers without touching the database — it is the liveness
probe. `/health/ready` reports dependencies and is the readiness probe. Wiring
these the wrong way round makes Kubernetes restart healthy pods during a
database blip.

Lists accept `page`, `limit`, `sortBy` (`field:asc|desc`) and per-resource
filters. Unknown query keys are stripped rather than rejected, because proxies
and browsers add their own.

---

## Response shape

One envelope, everywhere, so a client writes its parsing once.

Success:

```json
{
  "success": true,
  "message": "Task created",
  "data": { "task": { "id": "…", "title": "…" } },
  "meta": { "page": 1, "limit": 10, "totalPages": 3, "totalResults": 24 },
  "requestId": "0142eab8-180f-4309-ac4f-a271881cc406"
}
```

Failure:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "details": [
    { "field": "password", "location": "body", "message": "must contain at least one number" }
  ],
  "requestId": "0142eab8-180f-4309-ac4f-a271881cc406"
}
```

`code` is a stable string from `src/utils/errorCodes.js`. Branch on it rather
than on `message`, which is written for humans and may be reworded. `stack`
appears only outside production.

`requestId` is read from `x-request-id` or generated, attached to every log
line, echoed on the response, and forwarded by the gateway — so one identifier
follows a request from the browser through the proxy to the database and into
your log aggregator.

---

## Error handling, layer by layer

The rule: each layer raises the most specific error it can, and exactly one
place turns errors into responses.

1. **Validation** — `validate.middleware.js` runs the Joi schema per segment
   and throws a 400 carrying every failing field, not just the first.
2. **Authentication** — `auth.middleware.js` distinguishes a missing token
   (`UNAUTHENTICATED`), a bad or expired one (`TOKEN_INVALID` /
   `TOKEN_EXPIRED`) and a valid token without the right (`FORBIDDEN`).
3. **Services** — throw `ApiError` with a meaningful status and code:
   `ApiError.conflict('Email is already registered', 'EMAIL_ALREADY_EXISTS')`.
   Services never touch `req` or `res`.
4. **Controllers** — wrapped in `catchAsync`, so both rejected promises and
   synchronous throws reach Express without a `try`/`catch` in sight.
5. **Models** — schema validation, unique indexes and pre-save hooks.
6. **Conversion** — `errorConverter` normalises anything that is not already
   an `ApiError`: Mongoose `ValidationError` → 400 with field detail,
   `CastError` → 400, duplicate key `E11000` → 409, JWT errors → 401.
7. **Response** — `errorHandler` is the only place that writes an error body.
   It logs 5xx at `error` and 4xx at `warn`, and in production replaces
   non-operational 500 messages with something generic so internals never leak.
8. **Process** — `uncaughtException` and `unhandledRejection` log, then close
   the server and exit so the orchestrator can replace the instance. A
   10-second timer forces exit if connections refuse to drain.

A deliberate detail: fetching a task that belongs to someone else returns
**404, not 403**. A 403 confirms the record exists, which leaks information
through enumeration.

---

## Authentication and authorization

**Tokens.** Access tokens are short-lived (15 minutes) and stateless. Refresh
tokens live 30 days, are stored **SHA-256 hashed** in MongoDB, and rotate on
every use: refreshing revokes the old token and issues a new pair. A stolen
refresh token is therefore useful only until the legitimate client refreshes,
and replaying a spent token returns 401. Tokens are signed HS256 with issuer
and audience, and both are verified on the way in.

**Password handling.** bcrypt at 12 rounds. Changing or resetting a password
revokes every refresh token for that user, so other sessions die. Login and
forgot-password answer the same way whether or not the address exists.

**Brute force.** Five consecutive failures lock the account for fifteen
minutes; a success clears the counter.

**Roles and rights.** `src/config/roles.js` maps roles to rights rather than
scattering role checks through the code:

```js
user  → tasks:manage-own, profile:manage-own
admin → the above + tasks:manage-any, users:read, users:write
```

The middleware reads as the sentence you want:

```js
auth(); // any signed-in user
auth('users:read'); // must hold the right
auth({ rights: ['users:read'], allowSelf: true, selfParam: 'userId' });
```

Adding a role means editing one map, not hunting for `if (role === 'admin')`.

---

## The test console

`public/index.html`, served at the gateway root, drives the API from a real
browser against its own origin. It runs fifteen calls in order, showing the
method, path, HTTP status, latency and a pass/fail verdict for each, and
expands to the raw request and response on click. Failed steps open
themselves.

Roughly a third of the checks are **negative**: a duplicate registration must
give 409, a weak password must give 400 naming `password`, a wrong password
must give 401, an unauthenticated list must give 401, and a spent refresh
token must give 401. A red HTTP status can therefore be a green check — which
is the point. Any smoke test that only asserts happy paths will happily pass
against an API that has stopped enforcing anything.

Below the sequence is a manual panel for registering, signing in, rotating
tokens, adding tasks and reading the counts by hand.

`src/scripts/smoke.js` runs the identical sequence from the command line and
exits non-zero on the first mismatch, which makes it a reasonable
post-deployment gate:

```bash
node src/scripts/smoke.js https://api.staging.example.com
```

The page uses external CSS and JS with no inline script or style, so it runs
under the strict CSP the gateway sends. If you fork it, keep it that way or
the console will silently stop working in production.

---

## Testing

```bash
npm test                 # 188 tests, 11 suites
npm run test:coverage    # plus coverage
```

Tests default to an in-memory MongoDB (`mongodb-memory-server`), which
downloads a `mongod` binary on first run. In a sandbox or CI where that
download is blocked, point the suite at a real server instead:

```bash
MONGODB_URL_TEST=mongodb://127.0.0.1:27017/boilerplate_test npm test
```

The included GitHub Actions workflow uses that variable with a `mongo:7`
service container.

Integration suites drive the real Express app through supertest, including the
gateway's proxying and circuit breaker. Between tests the collections are
cleared, not the database dropped, so indexes survive and unique-constraint
behaviour is genuinely exercised.

Coverage thresholds are set at 70/60/70/70 in `jest.config.js`. Current run:

```
Statements 93.33%   Branches 76.60%   Functions 88.23%   Lines 93.75%
```

Process entry points and the CLI scripts are excluded from coverage — they are
exercised by running them, and counting them would only dilute the number.

---

## Docker

```bash
export JWT_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

Three services: `mongo`, `api` (the core service) and `gateway` (the only one
with a published port, `8080`). Both Node services run the same image with
different commands.

The image is multi-stage, installs production dependencies only, runs as the
unprivileged `node` user, and uses `tini` as PID 1 so `SIGTERM` actually
reaches Node and the graceful shutdown runs instead of the container being
killed mid-request. Health checks are defined for all three.

Compose refuses to start without `JWT_SECRET` in your environment rather than
falling back to a default, because a boilerplate default secret that reaches
production is a boilerplate that shipped a vulnerability.

---

## Connecting a Flutter client

Only the Node side was in scope, but the API is set up for a mobile client:

- Send `Authorization: Bearer <access token>`. On a 401 with code
  `TOKEN_EXPIRED`, call `/auth/refresh-tokens`, replace **both** stored tokens
  and retry once. Because refresh tokens rotate, a client that stores only the
  new access token will be logged out on its next refresh.
- Store tokens in `flutter_secure_storage`, not `SharedPreferences`.
- Serialise one response envelope and one error envelope; every endpoint uses
  them. Switch on `code`, never on `message`.
- Render `details[]` under the matching form fields — `field` and `location`
  are there for exactly that.
- Set `CORS_ORIGINS` for Flutter Web. Native builds ignore CORS entirely.
- Point the app at the **gateway** port, not the service port.

---

## Verification

What was executed in building this, so you know which claims are tested and
which are merely intended:

- **188 tests across 11 suites pass**, run against a live MongoDB-compatible
  server, exiting cleanly with no leaked handles.
- **ESLint reports zero errors and zero warnings**; Prettier is applied
  throughout.
- **The full stack was run** — service and gateway as separate processes — and
  the fifteen-step smoke sequence passed 15/15 through the gateway.
- The console, its assets, the OpenAPI document and the gateway endpoints were
  each requested and checked for status, content type and security headers.

Four real bugs were found this way and fixed:

1. Mongoose's global `sanitizeFilter` wrapped legitimate query operators in
   `$eq` and broke registration outright. Removed; injection is blocked at the
   edges instead, by `express-mongo-sanitize` and Joi.
2. `catchAsync` let synchronous throws escape. Rewritten to catch both.
3. `http-proxy-middleware` v3 silently matched nothing when given a mixed
   string/glob `pathFilter` array — every proxied route 404ed. Replaced with an
   explicit predicate.
4. Helmet's default `upgrade-insecure-requests` would break the console's own
   assets when served over plain HTTP on a LAN address. Now production-only.

Two things could not be checked here and are worth your attention:

- The integration suites ran against a **MongoDB-compatible server rather than
  `mongod` itself**. Everything used is ordinary CRUD, but run `npm test` once
  against real MongoDB before trusting it. The CI workflow does exactly that.
- **No browser was available**, so the console's fifteen request paths, markup
  and CSP are verified but its rendered layout is not. Open it once.

A harmless `util._extend` deprecation warning comes from a transitive
dependency of `http-proxy`. It is upstream, not in this code.

---

## Before you ship

- [ ] `JWT_SECRET` is a real random secret, injected by your secret manager.
- [ ] `CORS_ORIGINS` is an explicit allow-list, not `*`.
- [ ] `TRUST_PROXY` matches how many proxies actually sit in front.
- [ ] `MONGODB_AUTO_INDEX=false`, with indexes created by migration.
- [ ] MongoDB requires authentication and is not reachable from the internet.
- [ ] `NODE_ENV=production`, which disables docs and stack traces.
- [ ] `src/services/email.service.js` is wired to a real provider. It ships as
      a logging no-op, so password-reset mail goes to your logs and nowhere
      else until you replace it.
- [ ] Rate limits use a shared store (Redis) if you run more than one instance.
      The default memory store counts per process, so three instances mean
      three times the intended limit.
- [ ] Logs ship somewhere you can search by `requestId`.
- [ ] `npm audit` is clean and CI is green against real MongoDB.

---

## License

MIT. Use it as a starting point.
