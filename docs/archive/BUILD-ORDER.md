> ARCHIVED — written for TypeScript/Prisma/Postgres by mistake. Not authoritative.

# BUILD-ORDER.md — how to build this backend, in order

Nine steps. Each is one Claude Code session, self-contained, with a checkpoint you can actually
verify before moving on. **Do not reorder them.** Steps 2 and 3 exist to make the rest safe; if you
build endpoints first, every trap in `CLAUDE.md` §8 has to be retrofitted into code that already
works, which is when they get missed.

Prerequisites in the repo already: `CLAUDE.md` at the root, `docs/BACKEND_SPEC.md`,
`scripts/verify-contract.sh`.

---

## Step 0 — Dependencies and environment

```bash
npm i express argon2 @prisma/client zod pino pino-http jsonwebtoken \
      express-rate-limit helmet bullmq ioredis
npm i -D typescript tsx prisma vitest supertest @types/express @types/node @types/jsonwebtoken
npx prisma init
```

**Not bcrypt.** See `CLAUDE.md` §5 — it truncates at 72 bytes and the spec forbids truncation.

Create `.env` from `CLAUDE.md` §13. Then:

> **Prompt:** Read `CLAUDE.md` §13. Create `src/config/env.ts` that validates every environment
> variable with Zod at boot and calls `process.exit(1)` with a clear message if any secret is
> missing or a duration is out of range. Export a typed `env` object. Also create
> `src/config/constants.ts` holding the OTP and token durations, read from `env`, so no handler
> ever hardcodes 600 or 900.

**Checkpoint:** deleting `JWT_ACCESS_SECRET` from `.env` makes the process refuse to start.

---

## Step 1 — Database

> **Prompt:** Read `CLAUDE.md` §3. Write `prisma/schema.prisma` exactly as specified there —
> `User`, `RefreshToken`, `OtpCode`, `ResetToken`, `OtpThrottle`, and the Phase 2 models
> (`WebhookEvent`, `Entitlement`, `AliasLink`). `User.id` must be a TEXT uuid, never an integer.
> Do not add tables that are not in that section — no health tables, no profile table. Run the
> migration and generate the client.

**Checkpoint:** `npx prisma studio` shows the tables, and `User.id` is text.

---

## Step 2 — The safety scaffold (before any endpoint)

This is the step that decides whether the app works. Everything here is a framework default that
violates the contract.

> **Prompt:** Read `CLAUDE.md` §4 and §8 in full. Build the wiring layer only — no auth logic yet:
>
> 1. `src/lib/apiError.ts` with the `ApiError` class and the `CODES` map exactly as §4 specifies.
> 2. `src/middleware/errorHandler.ts` — converts `ApiError` to its JSON body; for **any** unexpected
>    error logs it and returns `503 {"code":"unavailable"}`. It must never default to 401, 403, 404
>    or 409.
> 3. `src/middleware/jsonParseError.ts` — catches `express.json()` SyntaxError and returns
>    `400 {"code":"invalid_input"}` as JSON, not HTML.
> 4. `src/middleware/authNotFound.ts` — a catch-all mounted at the END of the auth router returning
>    `503 {"code":"unavailable"}`, so no path under `/auth` can ever return 404.
> 5. `src/middleware/requireAuth.ts` — verifies the bearer access token, returns `401` (never 403)
>    on an expired or invalid one. It is applied to `/auth/me` ONLY, never with `router.use`.
> 6. `src/app.ts` wiring them in exactly the order given at the end of §8.
> 7. Stub all eight routes returning `503` for now, so the router shape exists.
>
> Then write `tests/contract/wiring.test.ts` asserting: `POST /auth/does-not-exist` is not 404;
> `POST /auth/register` with an empty body is not 401, 403 or 409; an unparseable JSON body returns
> 400 with a JSON content type; an unhandled throw returns 503, not 500 or 401.

**Checkpoint:** run `./scripts/verify-contract.sh http://localhost:3000/v1` — section 12 (status
discipline) should already pass, everything else fails. That is correct at this stage.

---

## Step 3 — Token service

> **Prompt:** Read `CLAUDE.md` §6.3 and §7. Build `src/services/token.service.ts`:
> `issuePair(userId)`, `rotate(refreshToken)`, `revoke(refreshToken)`, `revokeAllForUser(userId)`.
> Refresh tokens are 32 random bytes stored as sha256 only, never in plaintext, never logged.
> Rotation sets `replacedById` and `rotatedAt` and keeps `familyId`. **Implement the 60-second
> grace window:** a token presented within `REFRESH_ROTATION_GRACE_SECONDS` of its own rotation
> returns its replacement pair instead of failing. `rotate` returns `null` only for a genuinely
> dead token — never throws for a transient failure.
>
> Unit-test the grace window specifically: rotate, then present the old token at t+1s (must
> succeed) and at t+61s (must return null).

**Checkpoint:** the grace-window tests pass. This one race is what signs pilgrims out in the field.

---

## Step 4 — register, login, me

> **Prompt:** Read `CLAUDE.md` §5, §6.1, §6.2, §6.8. Implement those three endpoints.
> argon2id with the parameters in §5. Email normalized with `.trim().toLowerCase()` server-side.
> Unknown email at login runs a dummy argon2 verify so timing does not leak. `emailVerified: true`
> always. Register returns 201. **No 429 and no 401/403 on register.** `/auth/me` returns a bare
> user object, not wrapped.
>
> Every response goes through the §4 helper. Add contract tests for each row of the error tables in
> §6.1 and §6.2.

**Checkpoint:** `verify-contract.sh` sections 1–6 pass.

---

## Step 5 — refresh and logout

> **Prompt:** Read `CLAUDE.md` §6.3 and §6.7 and rule 5 in §1. Implement both. Copy the try/catch
> shape in §6.3 verbatim — an unexpected error returns **503, never 401**. `/auth/logout` returns
> `204` for everything, including `{"refreshToken": ""}` and unknown tokens.
>
> Add contract tests: a malformed refresh body returns something other than 401/403; an unparseable
> body likewise; logout is idempotent across three calls with the same token.

**Checkpoint:** `verify-contract.sh` sections 7 and 11 pass.

---

## Step 6 — OTP and the reset flow

The trickiest ordering rules in the spec live here.

> **Prompt:** Read `CLAUDE.md` §6.4, §6.5, §6.6 and §9. Build `src/services/otp.service.ts`,
> `email.service.ts` (enqueue only, never await SMTP), the BullMQ job, and the three endpoints.
>
> The rules that are easy to get wrong, all of which need a test:
> - `forgot-password` returns a byte-identical 200 body for registered and unregistered addresses,
>   in comparable time. Never 404.
> - `verify-otp` checks **lockout before the code**, so a locked-out pilgrim typing the right code
>   is still told to wait.
> - An **expired code does not increment the attempt counter**.
> - A resend **voids the previous code and resets attempts to zero**.
> - An unknown address at `verify-otp` answers `400 invalid_otp`, never 404 or `account_not_found`.
> - `verify-otp` returns a reset token and **no session** — no accessToken, no refreshToken.
> - The reset token is single-use, marked consumed in the same transaction as the password update.
> - `reset-password` returns `204` with no body and no tokens.
>
> In development write the OTP email to `/tmp/emails/` instead of sending, and log the file path.

**Checkpoint:** `verify-contract.sh` sections 8–10 pass. Then trigger a reset, read the code from
`/tmp/emails/`, and re-run with `OTP_CODE=123456` so section 13 runs too.

---

## Step 7 — Full conformance

> **Prompt:** Run `./scripts/verify-contract.sh` against the local server and fix every failure.
> For each fix, add the matching test under `tests/contract/` so it cannot regress. Then work
> through the §12 checklist in `CLAUDE.md` and add any test the script does not cover — especially
> the 120-character passphrase authenticating (the bcrypt-truncation probe) and `user.id` staying
> identical across register, login, refresh and `/auth/me`.

**Checkpoint:** script exits 0. Green means safe to deploy, not yet safe to hand over.

---

## Step 8 — Deploy to staging, then re-verify through the proxy

**This is where a green local run can still fail in production**, and it is the step people skip.

Nginx, Cloudflare, ALB and Render all return their own HTML `404` and `502` pages, and the client
classifies `404`, `409` and `429` **by status alone** — a non-JSON body does not save you. A
platform 404 on a misrouted path tells a pilgrim their account does not exist.

Checks after deploying:

1. Run `./scripts/verify-contract.sh https://staging-api.../v1` — against the real hostname, through
   the real proxy. Section 12 is the one that matters here.
2. `curl -i https://staging-api.../v1/auth/nope` — must not be 404.
3. `curl -i https://staging-api.../v1/totally/wrong/path` — outside `/auth` a 404 is fine, but
   confirm nothing rewrites it back under `/auth`.
4. Confirm no API-gateway or WAF auth sits in front of `/auth/refresh`. Anything there returning
   `401` with a JSON content type signs pilgrims out.
5. Confirm no HTTP→HTTPS redirect and no trailing-slash redirect on the API host. The client follows
   nothing.
6. Confirm the response time on `/auth/forgot-password` is well under 15 seconds and identical for a
   known and an unknown address.

**Then hand the app developer the staging base URL**, not production:

```
flutter run --dart-define=HAJJCARE_API_BASE_URL=https://staging-api.hajjcare.example/v1
```

Ask them to confirm the mock is actually off — `--dart-define=HAJJCARE_USE_MOCK_BACKEND=false` is
the switch to check first if the app seems not to be calling your server.

---

## Step 9 — RevenueCat webhook (Phase 2, after auth is live)

> **Prompt:** Read `CLAUDE.md` §10. Implement `POST /webhooks/revenuecat` with HMAC-SHA256
> verification over the **raw body bytes**, mounted with `express.raw()` before `express.json()`.
> Store the event with a unique constraint on `event.id`, return `200` within 60 seconds, process on
> a queue. Match on `entitlement_ids` containing the configured entitlement id — never on
> `product_id`. Store anonymous `$RCAnonymousID:` events and reconcile via `aliases`. Only
> `CANCELLATION` with `cancel_reason: "CUSTOMER_SUPPORT"` revokes. No expiry column, no sweeper.
> Unknown event types are stored and answered `200`.

Do not start Phase 3 (family groups) — nothing in the app consumes it, and `CLAUDE.md` §11 explains
why the permission model must not ship before the screen that sets it.

---

## Two things blocking you that are not code

1. **Answer the seven questions in `CLAUDE.md` §14 with the Flutter developer.** Three of them
   change server behaviour: whether `429` is allowed on login, whether `attemptsRemaining` is sent
   on a wrong OTP, and what language the OTP email is written in. The email one is the urgent one —
   the app sends no locale today, so localised emails need a client release, and clients in the
   field during Hajj season may not be able to take one.

2. **Get `lib/features/auth/data/mock_auth_remote_data_source.dart` from the Flutter repo.** The
   spec names it the tiebreaker for anything ambiguous, and the Prisma schema in `CLAUDE.md` §3 was
   derived from the API contract alone. If the mock holds a field the schema is missing, the mock
   wins.
