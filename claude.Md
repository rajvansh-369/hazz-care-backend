# CLAUDE.md — HajjCare Backend API

> **Product:** HajjCare — *Your Health. Your Hajj. Your Peace of Mind.*
> **This repo:** the Node.js API that powers the HajjCare Flutter app.
> **Reconciled:** PRS v2.0 (product spec) + BACKEND_SPEC.md (client contract, commit `040b977`).

---

## 0. Precedence — read this first

Two documents describe this backend and they do not agree. The rule is:

1. **`BACKEND_SPEC.md` wins for anything the shipped Flutter client calls today.**
   It was reverse-engineered from the client's actual code. If you deviate, the app breaks
   in the field during Hajj, when a client release cannot be pushed.
2. **This file (Layer B) is the roadmap for everything the client does *not* call yet.**
   Nothing in Layer B may be built until the decision listed against it is made.
3. **PRS v2.0 is superseded** on three points that have already changed:
   season-scoped pass → lifetime pass; direct store receipt verification → RevenueCat;
   phone-first OTP → email + password (client already ships this).

If a prompt asks you to build something in Layer B, stop and ask.

---

# LAYER A — THE FROZEN CONTRACT

Everything in this layer is what the shipped client depends on. Changing any shape, status,
key or code here requires a coordinated client release.

## A1. Scope

Nine endpoints. Nothing else exists.

```
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/forgot-password
POST /auth/verify-otp
POST /auth/reset-password
POST /auth/logout
GET  /auth/me                 ← only endpoint with an Authorization header
POST /webhooks/revenuecat     ← server-to-server, client never calls or waits on it
```

## A2. Transport

| Rule | Value |
|---|---|
| Base path | The client's base URL already contains the version segment (`https://api.../v1`). Paths append verbatim → mount routes at the **root**, so the final URL is `<base>/auth/login`. **Not** `/api/v1`. |
| Body format | **Bare JSON object at the top level. No envelope.** `{"tokens":…, "user":…}` is correct; `{"success":true,"data":…}` fails to parse and the app is unusable. |
| Key casing | camelCase in JSON, request and response. `refreshToken`, not `refresh_token`. |
| Timeouts | Client: connect 10s, send 15s, receive 15s. Anything slower is indistinguishable from offline. |
| Auth | `Authorization: Bearer <accessToken>` on `/auth/me` only. No cookies, no CSRF, no redirects. |

**This replaces PRS §2's `{success, data, meta}` envelope and `/api/v1` base path.** Those were
written before the client existed. The client has no envelope-unwrapping code.

## A3. Error contract

```jsonc
{ "code": "email_taken",
  "errors": [ { "field": "email", "code": "email_taken", "message": "logs only" } ] }
```

Codes are **lowercase snake_case**, and the client's screens switch on them:

`email_taken`, `invalid_credentials`, `account_not_found`, `invalid_reset_token`,
`too_many_attempts`, `otp_expired`, `invalid_otp`, `invalid_input`, `password_too_short`,
`email_invalid`, `session_revoked`

**This replaces PRS §2's SCREAMING_SNAKE code list** (`UNAUTHENTICATED`, `ENTITLEMENT_REQUIRED`
etc.). Those codes are not in the client. Adding a *new* code is safe — the client degrades to a
generic banner. Renaming an existing one changes app behaviour silently.

`message` is for our logs. Every user-facing word comes from the app's own translation files in
seven languages. The server does **not** localize error text for the client.

### The four status-code landmines

1. **Never return `404` from any path under `/auth`**, including unknown routes and typos.
   The client renders any 404 as *"We could not find an account for that email address."*
   A missing route would tell a pilgrim their account does not exist.
2. **Never return `409` under `/auth`** except a duplicate registration. Any 409 renders as
   *"That email already has an account."*
3. **`POST /auth/refresh` returning `401`/`403` with a JSON body is the only response in the
   entire API that logs a pilgrim out.** Never send it for rate limiting, load, deploys,
   validation errors, or an unexpected exception. Under load answer `429` or `503`.
4. **Never `429` on `/auth/login`.** The client's 429 copy reads *"wait, then ask for a new
   code"* — written for the OTP screen, nonsense on a sign-in form.

Guard these in error middleware, not by remembering. Mongoose's E11000 (duplicate key) must not
map to 409 except for duplicate email on register. Mongoose's CastError (malformed ObjectId) must
not map to 404 under `/auth` — map both to 400 instead. See §A8 for details.

## A4. Auth model — email and password

**This replaces PRS §4's phone-first OTP flow.** The client ships email + password sign-in,
sign-up, and email-OTP password reset. `/auth/otp/request` and `/auth/otp/verify` do not exist
in the client. Switching to phone-first is a product decision that costs a full client rewrite
of the auth feature — see Layer B.

### Shared shapes

```jsonc
// AuthTokens
{ "accessToken": "…", "refreshToken": "…", "expiresIn": 900 }   // expiresIn optional, SECONDS

// AuthUser
{ "id": "…", "email": "…", "fullName": "…"|null, "emailVerified": true }

// AuthSession — body of login, register, refresh
{ "tokens": {…}, "user": {…} }   // user REQUIRED on login+register, optional on refresh
```

`GET /auth/me` returns a **bare AuthUser**, not `{"user": …}` and not user+journey+entitlement.

> **`user.id` is the primary key of the pilgrim's local Drift database.** It must be an opaque
> **string** (never a bare integer in JSON), stable forever, and identical across register,
> login, refresh and `/auth/me`. If it changes, that pilgrim's health passport and medication
> schedule stop being associated with them.

### Token lifetimes

| | Value | Firmness |
|---|---|---|
| Access token | 15 min (`expiresIn: 900`) | proposal, any value works |
| Refresh token | **≥ 45 days**, 60 proposed | **firm floor.** PRS said 30d — that is a bug: a Hajj trip runs ~40 days offline |
| Reset token | 600s, single-use | single-use firm |
| OTP code | 600s | see A6 |

### Refresh rotation

Rotate, and keep the old token working for a **60-second grace window** returning the current
pair. Two uncoordinated client callers exist (a background refresher every ~6h, and the 401
interceptor). **PRS §4's "reuse detection revokes the whole device family" without a grace
window will sign pilgrims out at random.** If you would rather not rotate at all, that is
simpler and safe — just echo the same `refreshToken` back. The field is required either way.

### The client never asks whether its session is valid

A local session is good for **45 days with zero successful refreshes**. No 401 outside
`/auth/refresh` signs anyone out. A timeout, DNS failure, captive portal, or 5xx changes
nothing. **Do not design any flow that assumes the client will log out when you reject it.**

A pilgrim locked out in Mina has lost their medication alarms and their emergency button,
days from a working data connection.

### Access token claims

The client decodes nothing. Claims are for our middleware only. **Drop PRS's `ent` entitlement
hint claim** — there is no server-side entitlement gate (see A5).

## A5. Entitlement — lifetime pass, and not this API's concern

**This replaces PRS §5 entirely.**

- The pass is a **lifetime, non-consumable purchase**. Not season-scoped, no `expires_at`, no
  grace period, no repurchase for a later season.
- The client buys through RevenueCat and writes entitlement to its **own local database**.
  The route gate that decides whether a pilgrim may use the app reads that local row and
  **never asks a server**.
- Therefore: **no entitlement endpoint, no `GET /subscription/entitlement`, no receipt
  verification endpoint the client calls, no `entitlement.middleware.ts`, no
  `entitlementExpiry.job.ts`, and no expiry column anywhere.**
- `lib/payments/{apple,google,stripe,tap}.ts` is superseded by RevenueCat. Delete it.

The server keeps a record only so support can answer *"did this person pay"* and so a refund
has somewhere to land.

### `POST /webhooks/revenuecat`

- **Auth:** constant-time compare of the `Authorization` header against `RC_WEBHOOK_SECRET`.
  No signature scheme exists; the shared secret is the whole of it. Never log it.
- **Idempotency is required.** `event.id` is the primary key with a unique constraint. Drop
  duplicates before any work — RevenueCat retries for ~72 hours, so duplicate delivery is
  normal operation.
- **Answer fast:** persist the raw event, return `200`, process on BullMQ.
- Event handling:

| Type | Action |
|---|---|
| `INITIAL_PURCHASE`, `NON_RENEWING_PURCHASE` | Grant entitlement to `app_user_id` |
| `TRANSFER` | Move it, reading `transferred_from` / `transferred_to` |
| `CANCELLATION` + `cancel_reason: CUSTOMER_SUPPORT` | Revoke. **The only revoking event** |
| `EXPIRATION` | Log loudly, alert, **change nothing** — should never arrive |
| `SUBSCRIPTION_*`, `BILLING_ISSUE`, `PRODUCT_CHANGE` | Ignore |

- `app_user_id` is our own `user.id`. If one arrives matching `^\$RCAnonymousID:` that is a
  client bug — alert, do not create a user.
- `expiration_at_ms` is always null. Do not read it, persist it as an expiry, or sweep it.
- Never grant on `environment: "SANDBOX"` in production.

## A6. Password reset — the four-call flow

```
POST /auth/forgot-password { email }
   → 200 { expiresInSeconds:600, resendAfterSeconds:60, codeLength:6 }
POST /auth/verify-otp      { email, code }
   → 200 { resetToken, expiresInSeconds:600 }
POST /auth/reset-password  { resetToken, password }
   → 204, no body, NO TOKENS
   … pilgrim is sent to the sign-in screen and signs in normally
```

The client renders **live countdowns from these numbers**, so they are a contract. Send them on
every response including resends — a resend returns a full fresh 600/60, not the remainder.

**`codeLength` must be 6.** The translated copy in all seven languages says "a six-digit code"
in prose; 4 or 8 makes the text lie in every locale.

### Rules that are easy to get wrong

- **Check the lockout *before* the code**, so a locked-out pilgrim typing the *right* code is
  still told to wait. Otherwise the lockout is decorative.
- **An expired code must not consume an attempt.** Charging one punishes a pilgrim for a clock.
- **A resend voids the previous code and resets attempts to zero.** The Resend button exists to
  rescue a locked-out pilgrim. A separate, slower limit on resends themselves is fine → `429`.
- **Five attempts, not three.** These pilgrims are reading six digits off a phone screen in
  bright sun. A limiter that locks on the second slip is a support call, not a security control.
- **The reset token is never a session.** Short-lived, single-use, scoped to setting a password
  on one account. Not accepted as a bearer token anywhere. Issuing a session from a verified
  code would make password reset a second, weaker way to sign in.
- **`reset-password` returns no tokens.** Typing the new password on the sign-in screen is what
  proves they know it.

### Enumeration safety

`forgot-password` returns `200` with an identical body for **every** syntactically valid
address, registered or not — and must not differ by **timing** either. Enqueue the mail, never
await SMTP, keep the unknown-address path doing comparable work.

`verify-otp` for an unknown address answers `invalid_otp`, exactly like a wrong code. Never
`404`, never `account_not_found`.

`login` for an unknown address answers `401 invalid_credentials`, never `404`. Run a dummy
password hash so timing does not leak.

## A7. Rate limiting — exactly here, nowhere else

| Route | Limit |
|---|---|
| `/auth/forgot-password` | per-email and per-IP → `429 {"code":"too_many_attempts"}` |
| `/auth/verify-otp` | the 5-attempt per-OTP lockout above |
| `/auth/login` | **none.** Adding one needs a new error code + 7 translations |
| `/auth/refresh` | if limited at all → `429` or `503`. **Never `401`** |

Mount per-route, never on the router, so a future route cannot silently inherit one.

## A8. Layer A data model

Mongoose collections (MongoDB):

```
User                 email (unique, lowercase: true), passwordHash,
                     fullName?, emailVerified (default: true), timestamps
Token                tokenHash (unique index), user (ObjectId ref),
                     type ('refresh' | 'resetPassword'),
                     expiresAt, revokedAt?, replacedBy?
PasswordResetOtp     email (indexed), codeHash, expiresAt, attempts (default: 0),
                     lockedUntil?, consumedAt?
RevenueCatEvent      _id (set to event.id directly), type, appUserId,
                     raw (Mixed), receivedAt
Entitlement          user (unique), productId, grantedAt, revokedAt?
```

### Critical Mongoose-specific rules

**`user.id` must serialise as a string.** Mongoose's `_id` is an ObjectId; the `toJSON` transform
mapping `_id` → `id` (and stripping `__v` and `passwordHash`) is load-bearing, not cosmetic.
It must produce a JSON string on register, login, refresh and `/auth/me`, identical across all four.
The client's parser fails on a bare integer.

**Four things MongoDB does differently:**

1. **Reset-password needs a transaction.** Three writes must be atomic: mark the reset token used,
   update the password hash, revoke all of that user's refresh tokens. A crash between writes two
   and three leaves the password changed and old sessions alive. MongoDB transactions require a
   replica set — a standalone mongod will not do it. A single-node replica set is enough
   (`--replSet rs0` plus `rs.initiate()`); use it in dev and CI, not only production.

2. **E11000 must not become a blanket 409.** Mongoose throws the same duplicate-key error for every
   unique index. Map it to `409 email_taken` ONLY for a duplicate email on register. Any other
   E11000 under `/auth` — including `Token.tokenHash` and `RevenueCatEvent._id` — must not surface
   as 409, because the client renders any 409 as *"That email already has an account."*

3. **CastError must not become a 404.** A malformed ObjectId throws a Mongoose CastError, which many
   boilerplates map to 404. Under `/auth` that renders as *"We could not find an account for that
   email address."* Map it to 400 instead.

4. **TTL indexes are the cheap win.** Use `expireAfterSeconds` on `PasswordResetOtp.expiresAt` and on
   expired `Token` documents to remove the need for a cleanup job. TTL deletion is lazy (MongoDB
   sweeps roughly once a minute), so never rely on it for correctness — always check `expiresAt`
   in code as well. It is garbage collection, not an expiry mechanism.

### Annotations

- **`replacedBy` and `revokedAt` on Token are REQUIRED** for the 60-second rotation grace window.
  The current `auth.service.js` deletes the old token outright; that is the bug.
- **PasswordResetOtp is keyed by EMAIL, not user,** so the flow behaves identically for addresses
  with no account.
- **`RevenueCatEvent._id = event.id` means idempotency comes free** from the primary key; a retry
  is an E11000 we drop.
- **Entitlement has NO `expiresAt` field. Forbidden.** The pass is lifetime.
- **Store only hashes:** never a raw refresh token, reset token, or OTP code.
- **Password hashing:** bcrypt or argon2id, **min 8 characters, no maximum, no composition rules,
  no truncation.** A server stricter than the client turns an inline rule the pilgrim could have
  followed into an opaque server error.

## A9. Layer A definition of done

Contract tests (`tests/contract/`) that test the *client's assumptions*, not our implementation:

- No path under `/auth` returns 404 for any input, including unknown routes
- No path under `/auth` returns 409 except register with a duplicate email
- `/auth/refresh` returns 401 only for a genuinely dead token; a simulated DB failure → 5xx
- `/auth/login` never returns 429
- Every success body is a bare object; a recursive walker asserts camelCase on every key
- `/auth/me` returns a bare user
- Every refresh response contains `tokens.refreshToken`, even when not rotating
- The old refresh token still works within 60s and fails after
- `user.id` is a JSON string, identical across register/login/refresh/me
- `forgot-password` returns byte-identical bodies for known and unknown addresses
- `verify-otp` returns `invalid_otp` for both an unknown address and a wrong code
- A reset token cannot be used twice; `reset-password` returns no tokens
- `logout` with a garbage token returns 204

---

# LAYER B — ROADMAP (NOT BUILT)

Everything below is preserved from PRS v2.0. **None of it may be built until the decision
listed against it is recorded.** These are product, legal and compliance decisions, not
architectural ones.

## B1. Blocked on: the health-data decision

`BACKEND_SPEC.md` §1: *"Health data does not leave the device unless the pilgrim has explicitly
turned sharing on, so there is no health-data endpoint in this document and no endpoint in this
document should ever grow one without that conversation happening first."*

**Blocked:** `health.routes.ts`, `passport.routes.ts`, `vitals.routes.ts`, `activity.routes.ts`,
`medicines.routes.ts`, `sharing.routes.ts`, `sync.routes.ts`, `lib/crypto/fieldCipher.ts`,
and the PRS models `HealthProfile`, `HealthCondition`, `Allergy`, `Vaccination`, `VitalReading`,
`ActivityDay`, `HealthPassport`, `SharingGrant`, `ConsentEvent`, `Medicine`,
`MedicationSchedule`, `MedicationDose`, `PharmacistInquiry`.

**Needed before building:** whether PHI is stored server-side at all; if yes, data residency
under Saudi PDPL, the GDPR lawful basis, the consent artifact, and a DPIA. This is the largest
open item in the project and it is not a coding decision.

The PRS design for these is sound and worth keeping when the decision lands — particularly:
`passportProjection.service.ts` as the **single** scope-filtering boundary that every read path
goes through; the `EMERGENCY` scope unlocking only while an `SosEvent` is `ACTIVE`; and
after-the-fact disclosure to the user (*"Dr. X viewed your emergency info at 14:32"*).

## B2. Blocked on: offline-first architecture review

**Blocked:** `realtime/` (Socket.IO), `jobs/medicationReminder.job.ts`, `jobs/sosEscalation.job.ts`.

The client has no websocket code, and medication reminders are **local device alarms**. A server
push reaches a pilgrim in Mina exactly when they least have signal. The PRS SOS escalation
ladder is good design *for the amplification path*, but the PRS itself is right that the client
must fire an SOS from cached contacts with no network — so this can never be the only path.

**Needed before building:** confirmation that the client will add a websocket + FCM path, and
what an SOS does when the API is unreachable.

## B3. Superseded, do not build

| PRS section | Why |
|---|---|
| §4 phone-first OTP | Client ships email + password. Switching is a full auth rewrite on the client |
| §5 season-scoped pass, `Season` model, `expires_at`, `entitlementExpiry.job` | Pass is lifetime. Expiry is explicitly forbidden |
| §5.1/§5.3 Apple/Google/Stripe/Tap verification, `lib/payments/*` | RevenueCat handles this; one webhook replaces all of it |
| §2 response envelope, SCREAMING_SNAKE codes, `/api/v1` | Breaks the shipped client (see A2, A3) |
| §12 `GET /privacy/export`, `DELETE /privacy/account` | Still legally required — but scope depends on B1. Revisit with B1 |

## B4. Still open (from PRS §17, unchanged)

1. PRS Section 3 is missing entirely — likely the Home/dashboard spec
2. Pharmacist inquiry: staffing, SLA, chat vs ticketed
3. Operator integration: partner API and dashboard, or same app?
4. Wearables: HealthKit / Health Connect client-side only, or server-side OAuth?
5. Weather provider and budget → determines cache TTL and cell resolution
6. Refund policy, and what happens to a pilgrim whose Hajj is cancelled after purchase
7. Saudi/web payment channel — moot while RevenueCat covers store purchases
8. Does emergency broadcast integrate with 997 / Tawakkalna / Nusuk, or contacts-only?
9. Data residency under PDPL — **blocks B1**
10. Dependent consent for cognitive impairment: legal basis and recorded artifact

## B5. Answers owed back to the client team

`BACKEND_SPEC.md` §8 is waiting on us. Each has a matching client change, so decide before
either side hardcodes:

- Access token lifetime actually chosen
- Whether we rotate refresh tokens, and the grace window
- Whether we send `attemptsRemaining` on `invalid_otp` (real usability win for elderly users,
  small enumeration signal)
- Whether we send `Retry-After` on a 429
- What language the reset email is written in — **the client sends no locale today**, so
  localised emails need a client change first
- Whether login gets brute-force protection (needs a new code + 7 translations)

---

# CROSS-CUTTING — applies to both layers

## C1. Stack

```
Runtime      Node.js 20 LTS
Language     JavaScript (CommonJS, as the existing boilerplate uses)
Framework    Express 4 (thin) — logic in services, not routes
DB           MongoDB + Mongoose 8, running as a single-node replica set
Cache/Queue  Redis 7 + BullMQ
Validation   Joi (already wired via the validate middleware)
Logging      Winston/Pino as the boilerplate ships, with the redaction list in §C3
Testing      Jest + Supertest + mongodb-memory-server
```

**Stack decision made 2026-08-30:** This supersedes the prior TypeScript + PostgreSQL + Prisma
specification. The decision was deliberate — the boilerplate is production-grade JavaScript on
Mongoose, and nothing in Layer A's contract depends on the language or ORM choice (see BACKEND_SPEC.md §2).

Redis/BullMQ is justified in Layer A for exactly two things: enqueuing the reset email so
`forgot-password` never awaits SMTP, and processing RevenueCat events off the HTTP path.
Socket.IO is not justified yet (B2).

## C2. Layering

```
routes/        HTTP only: parse, validate, call service, shape response. No DB, no rules.
services/      All business logic. Takes a ctx. Throws ApiError.
repositories/  Prisma access, one file per aggregate. No business rules.
jobs/          BullMQ processors. Thin wrappers over services.
lib/           Crypto, tokens, mail.
```

A route handler longer than ~15 lines is a smell. Write the Zod schema first and derive types
from it. Add a migration for every schema change; never edit an applied migration.

## C3. Security

- **Pino redaction:** `req.headers.authorization`, `req.body.password`, `req.body.code`,
  `req.body.refreshToken`, `req.body.resetToken`, `*.email`, `*.purchaseToken`.
  Never log the RevenueCat shared secret.
- Secrets only via env, validated at boot by `config/env.ts` (Zod). **Boot must fail loudly on
  a missing secret** rather than starting with a silent default.
- TLS everywhere. No identifiers in URLs for shared resources.
- OTP codes, refresh tokens and reset tokens are stored as hashes, never raw.

## C4. Working agreements

**Do:**
- Read Layer A before writing anything that touches `/auth` or the webhook
- Quote the relevant line of `BACKEND_SPEC.md` back to me instead of guessing at a shape
- Prefer boring, explicit code. This is health software read at 3am by someone debugging why
  an alert didn't fire
- Ask before adding a dependency

**Don't:**
- Change any shape, key, status or error code in Layer A without flagging it as a breaking
  change that needs a client release
- Build anything in Layer B
- Introduce recurring-billing or expiry concepts. The pass is lifetime
- Generate medical advice, dosages, interaction warnings, or diagnoses from any code path
- Put a paywall in front of SOS, emergency contacts, allergies, or the medication list —
  and note that today none of these touch the server at all

## C5. Environment variables (Layer A only)

```bash
NODE_ENV=            PORT=            API_BASE_URL=
DATABASE_URL=        REDIS_URL=
JWT_ACCESS_SECRET=   JWT_ACCESS_TTL=15m
REFRESH_TTL_DAYS=60             # firm floor 45 — see A4
RC_WEBHOOK_SECRET=              # RevenueCat shared secret, long and random, never logged
SMTP_URL=            MAIL_FROM=
SENTRY_DSN=          LOG_LEVEL=info
```

The PRS list of Apple / Google / Stripe / Tap / FCM / WhatsApp / weather / S3 /
`FIELD_ENCRYPTION_KEY` variables belongs to Layer B. Do not add them to `config/env.ts` until
the matching decision lands — a required-but-unused secret means the service will not boot.
