# Deploying the HajjCare API

Platform-neutral. Any host that runs a container (or Node 22) behind HTTPS will do. After the
first deploy to staging, work through [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md) before giving
anyone the base URL.

## 1. MongoDB: a replica set is required

Token rotation and password reset run in transactions, and a standalone `mongod` refuses them.
With `NODE_ENV=production` the process **refuses to start** unless `MONGODB_URL` is either a
`mongodb+srv://` URL or carries `replicaSet=<name>` in its query string.

**MongoDB Atlas** is a replica set on every tier, including the free one. Use the SRV form
Atlas gives you under *Connect → Drivers*, with the database name added:

```
mongodb+srv://<user>:<password>@<cluster>.<id>.mongodb.net/hajjcare?retryWrites=true&w=majority
```

Self-hosted: `mongodb://<host1>:27017,<host2>:27017/hajjcare?replicaSet=rs0` (a one-node
replica set works; see `docker-compose.yml` for how to initiate one).

## 2. Environment variables

Validated at boot by `src/config/config.js`; a missing secret or out-of-range value stops the
process. **Secret** = generate a fresh random value per environment and keep it in the platform's
secret store:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Production value | Secret |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | whatever the platform routes to; default `5000` | |
| `API_PREFIX` | `/api/v1` (the app's base URL is `https://<host>/api/v1`) | |
| `LOG_LEVEL` | `info` | |
| `CORS_ORIGINS` | `*` is fine: the mobile app sends no `Origin` | |
| `TRUST_PROXY` | number of proxies in front of the app — see §5 | |
| `MONGODB_URL` | see §1 | **yes** (holds the DB password) |
| `MONGODB_AUTO_INDEX` | `true` (indexes are also synced explicitly, §3) | |
| `JWT_ACCESS_SECRET` | ≥ 32 characters, random | **yes** |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | |
| `JWT_REFRESH_EXPIRATION_DAYS` | `60` (refuses < 45: a Hajj runs ~40 days offline) | |
| `REFRESH_ROTATION_GRACE_SECONDS` | `60` | |
| `RESET_TOKEN_TTL_SECONDS` | `600` | |
| `OTP_HMAC_SECRET` | ≥ 32 characters, random | **yes** |
| `OTP_TTL_SECONDS` | `600` | |
| `OTP_RESEND_AFTER_SECONDS` | `60` | |
| `OTP_LENGTH` | `6` (pinned) | |
| `OTP_MAX_ATTEMPTS` | `5` (refuses < 5) | |
| `OTP_MAX_SENDS_PER_HOUR` | `5` | |
| `FORGOT_PASSWORD_MIN_RESPONSE_MS` | `300` | |
| `PASSWORD_MIN_LENGTH` | `8` (pinned) | |
| `RATE_LIMIT_IP_PER_HOUR` | `300` | |
| `EMAIL_PROVIDER` | `smtp` (production refuses anything else) | |
| `SMTP_URL` | `smtp://<user>:<pass>@<host>:587` from your provider | **yes** |
| `EMAIL_FROM` | an address on your verified sending domain | |
| `RC_WEBHOOK_SECRET` | ≥ 32 characters, random. Required at boot although the webhook is not built yet | **yes** |
| `RC_WEBHOOK_HMAC_SECRET` | optional; leave unset until the webhook exists | **yes** |
| `HAJJCARE_ENTITLEMENT_ID` | `hajjcare_pass` | |

`EMAIL_DEV_DIR` and `MONGODB_REPLICA_SET` are not needed in production.

## 3. On every deploy

Run the index sync **before the new version takes traffic**:

```bash
npm run db:sync-indexes          # in the image: node scripts/sync-indexes.js
```

Mongoose never drops or alters an existing index, so a changed schema keeps enforcing the old
rule until this runs (CLAUDE.md §A11). Run it as a release/pre-deploy step with the production
environment variables. It prints what it dropped and created.

## 4. Run exactly ONE instance

The per-IP rate limiters on `/auth/refresh`, `/auth/forgot-password` and `/auth/verify-otp`
keep their counts **in process memory**. Two instances would each allow the full limit, so the
effective limit multiplies with the instance count. Stay at one instance (no autoscaling) until
the limiters use a shared store. The per-address OTP send limit is stored in MongoDB and is
already safe across instances.

Give the platform a stop grace period of **at least 35 seconds**. On SIGTERM the app stops
accepting connections, finishes in-flight requests, waits up to 10s for queued OTP emails,
closes MongoDB and exits 0; its own backstop forces an exit at 30s.

## 5. TRUST_PROXY

Set it to the **number of proxies** between the internet and the app (load balancer, platform
router, CDN): usually `1`, sometimes `2`. Left at `0` behind a proxy, every request appears to
come from the proxy's address, the per-IP limits count the whole world as one client, and one
pilgrim hammering Resend could rate-limit a whole hotel. Set too high, a client can spoof its
address with `X-Forwarded-For`.

## 6. SMTP

Use a real transactional provider with a **verified sender domain (SPF and DKIM, ideally
DMARC)**, and set `EMAIL_FROM` to an address on that domain. Without it the OTP email lands in
spam and the pilgrim cannot reset their password. The email is English only for now
(BACKEND_SPEC.md §8 item 17).

Sending never blocks a request: a failed send is retried in the background and logged without
the address or the code; the pilgrim's recovery is the Resend button.

## 7. Container

`Dockerfile` builds a `node:22-bookworm-slim` image with production dependencies only, running
as the unprivileged `node` user, with a `HEALTHCHECK` on `/api/v1/health`.

```bash
docker build -t hajjcare-api .
docker run --init -p 5000:5000 --env-file <production env file> hajjcare-api
docker run --rm --env-file <production env file> hajjcare-api node scripts/sync-indexes.js
```

Health endpoints: `/api/v1/health` (process up) and `/api/v1/health/ready` (MongoDB reachable).

Local full stack (MongoDB replica set + Mailpit + API, production mode): `docker compose up -d
--build`, then `MAILPIT_URL=http://localhost:8025 npm run contract -- http://localhost:5000/api/v1`.
