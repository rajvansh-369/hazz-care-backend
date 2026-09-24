> ARCHIVED — written for TypeScript/Prisma/Postgres by mistake. Not authoritative.

# CLAUDE.md — HajjCare Backend API

> **This file is subordinate to `docs/BACKEND_SPEC.md`.** That document was derived from the live
> Flutter client and re-verified against it on 24 September 2026. If anything here disagrees with it,
> **BACKEND_SPEC.md wins.** If BACKEND_SPEC.md is itself unclear, the tiebreaker is
> `lib/features/auth/data/mock_auth_remote_data_source.dart` in the Flutter repo — that mock is the
> executable version of this contract.
>
> **Goal of this repo:** build a server the Flutter app can point at by changing one build flag —
> `--dart-define=HAJJCARE_API_BASE_URL=https://api.hajjcare.example/v1` — with **zero client code
> changes**. Supplying a base URL switches the app off its built-in mock automatically. So this
> contract is not a guideline; it is an interface the app already ships against.

---

## 0. Corrections to earlier drafts — read before writing code

Two earlier documents (`CLAUDE.md v2.0` and `PHASE-1-AUTH.md`) were written before BACKEND_SPEC.md was
available. **Both are now void.** If any of their ideas reached the codebase, they are bugs:

| Earlier draft said | BACKEND_SPEC.md requires | Consequence if you keep the old way |
|---|---|---|
| `{ "success": true, "data": {...} }` envelope | **Bare JSON object at the root**: `{"tokens":…, "user":…}` | Every login and register fails to parse. Nobody can sign in. |
| `SCREAMING_SNAKE` codes (`EMAIL_ALREADY_REGISTERED`) | **lowercase snake_case**: `email_taken`, `invalid_credentials`, `invalid_otp`, `otp_expired`, `too_many_attempts`, `invalid_reset_token`, `invalid_input`, `password_too_short`, `email_invalid`, `account_not_found` | Client degrades to a generic error on every failure; no inline field messages. |
| Password reset via emailed **link** | Reset via **6-digit OTP emailed** → `verify-otp` → `resetToken` → `reset-password` | The whole reset flow is unreachable; three endpoints missing. |
| Email verification flow, `PENDING_VERIFICATION` status | **No verification flow exists in the client.** Return `emailVerified: true` as a placeholder | Registered pilgrims blocked by a gate the app has no screen for. |
| Rate-limit login and register with `429` | **Never `429` on `/auth/login` or `/auth/register`** | Sign-in form shows *"Wait a moment, then ask for a new code"* — nonsense where there is no code. |
| `403` for expired tokens, `404` for unknown accounts | **`401` only, never `403`. Never `404` under `/auth`** | `403` kills refresh-and-retry; `404` tells a pilgrim their account does not exist. |
| Sessions revoked on password change, `/auth/logout-all` | Not in the client. `/auth/logout` revokes **one** refresh token | Harmless if built, but the client will not react to it. |
| Entitlement endpoints the client calls | **No entitlement endpoint. Ever.** The pass lives in the client's local DB | An access check the app never makes, and a dangerous precedent. |
| Health data endpoints | **Health data never leaves the device** | A privacy commitment broken. |

Delete both files from the repo if they were committed.

---

## 1. The contract in one page

Twelve rules. Each is something the client breaks on, not a style preference.

1. **camelCase keys, request and response.** `refreshToken`, not `refresh_token`. The one exception is
   the RevenueCat webhook body, which arrives snake_case and is not ours to change (§10).
2. **Bare JSON objects at the top level.** No envelope, no wrapper, ever.
3. **JSON types are checked, and a wrong type fails the whole response.** `"emailVerified": 1` or
   `"true"` **fails a sign-in**. `"expiresIn": "900"` fails. Booleans must be `true`/`false`; numbers
   must be JSON numbers; `id`, `email`, `accessToken`, `refreshToken` must be non-null strings.
   Unknown extra keys are ignored, so **adding** a field is always safe.
4. **`user.id` is a non-empty string, stable forever, never reused.** It is the primary key of every
   user-owned table in the pilgrim's local SQLite database. A blank or whitespace-only id is rejected
   and no session is created. If it changes for an existing account, that pilgrim's health passport
   and medication schedule are orphaned.
5. **Only `POST /auth/refresh` answering `401` or `403` can sign a pilgrim out** — and a
   `Content-Type: application/json` header alone arms it, **with no body at all**.
   `res.status(401).json({})` on that route logs someone out. Use `429` or `503` for anything transient.
6. **`401`, never `403`, for an expired access token everywhere else.** The client's refresh-and-retry
   tests `statusCode == 401` and deliberately excludes `403`.
7. **Never `404` under `/auth` — including for an unknown route or a typo'd path.** Any `404` renders
   as *"We could not find an account for that email address."* On `/auth/forgot-password` it is worse:
   a `404` is shown as **success**, so a misrouted endpoint tells the pilgrim a code is coming when
   none was sent.
8. **Never `409` under `/auth` except for a duplicate registration.** Any `409` renders as *"That email
   address already has an account."*
9. **Never `401` or `403` from register, forgot-password, verify-otp or reset-password** — not from
   router-wide middleware, not for a missing API key. All four render as *"That email and password do
   not match"* on screens where no password was typed.
10. **Never `429` on `/auth/login` or `/auth/register`.** The rate-limit copy is written for the OTP screen.
11. **Refresh token lifetime ≥ 45 days.** Firm floor; 60 proposed. The client treats a stored session
    as valid for 45 days with no successful refresh, because a Hajj trip runs ~40 days offline.
12. **The client gives up at 15 seconds.** `/auth/forgot-password` must enqueue the email and answer
    immediately — never await SMTP.

---

## 2. Stack & layout

The client is agnostic to how this is built. Recommended and assumed below:

```
Node.js 20 LTS · TypeScript (strict) · Express 4 · PostgreSQL · Prisma
argon2 (NOT bcrypt — see §5) · Zod · BullMQ + Redis for email · Pino
Vitest + Supertest for the conformance tests in §12
```

```
src/
  app.ts                    express wiring — middleware ORDER matters, see §8
  server.ts
  config/env.ts             zod-validated; process exits on a missing secret
  config/constants.ts       OTP and token durations in one place
  routes/auth.routes.ts     the eight endpoints, nothing else
  routes/webhooks.routes.ts RevenueCat (§10) — raw body, mounted BEFORE express.json()
  controllers/auth.controller.ts
  services/
    auth.service.ts         register, login, me
    token.service.ts        issue, rotate, revoke, 60s grace window
    otp.service.ts          send, verify, lockout, resend
    password.service.ts     argon2 hash/verify
    email.service.ts        enqueue only
  repositories/
  lib/apiError.ts           THE error helper — §4
  jobs/sendOtpEmail.job.ts
  jobs/cleanupExpired.job.ts
prisma/schema.prisma
tests/contract/             §12 — these are the acceptance tests
scripts/verify-contract.sh  run green before handing over the base URL
```

**The base URL carries the version segment.** Routes here are exactly `/auth/*`; the app dev is given
`https://…/v1`, producing `/v1/auth/login`. Do not also put `/api/v1` inside the route definitions or
the paths double up.

---

## 3. Database schema

The client's mock holds accounts, refresh tokens, OTP codes and reset tokens in memory. This is that
same shape, persisted. Nothing more — **no health table, no profile table, and no entitlement table
the client reads.**

```prisma
model User {
  id            String   @id @default(uuid())   // TEXT. Never an integer — §1 rule 4
  email         String   @unique                 // stored LOWERCASE, trimmed
  passwordHash  String
  fullName      String?                          // optional; the UI always sends ≥2 chars today
  emailVerified Boolean  @default(true)          // placeholder — see §6.1
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastLoginAt   DateTime?

  refreshTokens RefreshToken[]
  otpCodes      OtpCode[]
  resetTokens   ResetToken[]
  entitlement   Entitlement?

  @@index([email])
}

model RefreshToken {
  id            String    @id @default(uuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash     String    @unique          // sha256 of the opaque token; never store the token itself
  familyId      String                     // rotation lineage
  replacedById  String?                    // set on rotation — powers the 60s grace window
  rotatedAt     DateTime?
  expiresAt     DateTime                   // now + 60 days
  revokedAt     DateTime?
  revokedReason String?                    // LOGOUT | ROTATED | PASSWORD_RESET | ADMIN
  createdAt     DateTime  @default(now())

  @@index([userId, revokedAt])
  @@index([familyId])
}

model OtpCode {
  id           String    @id @default(uuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash     String                      // sha256 of the 6 ASCII digits
  expiresAt    DateTime                    // now + 600s
  attempts     Int       @default(0)       // max 5 — an EXPIRED code must not increment this
  consumedAt   DateTime?
  supersededAt DateTime?                   // set when a resend voids this code
  createdAt    DateTime  @default(now())

  @@index([userId, consumedAt, supersededAt])
}

model ResetToken {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique
  expiresAt  DateTime                      // now + 600s
  consumedAt DateTime?                     // single-use is FIRM
  createdAt  DateTime  @default(now())
}

model OtpThrottle {                        // per-email resend and per-IP limits
  key         String   @id                 // "resend:<emailHash>" | "ip:<ip>"
  count       Int      @default(0)
  windowStart DateTime @default(now())
}

// Phase 2 only (§10). Written by the RevenueCat webhook, read by support. Never by the client.
model WebhookEvent {
  id          String   @id                 // RevenueCat event.id — the unique constraint IS the idempotency
  type        String
  appUserId   String
  aliases     String[]
  rawBody     Json
  receivedAt  DateTime @default(now())
  processedAt DateTime?
}

model Entitlement {
  id            String    @id @default(uuid())
  userId        String    @unique
  user          User      @relation(fields: [userId], references: [id])
  entitlementId String                     // "hajjcare_pass" — read from config, never hardcoded
  store         String
  transactionId String?
  purchasedAt   DateTime
  revokedAt     DateTime?                  // only a CUSTOMER_SUPPORT refund sets this
  // NO expiresAt column. The pass is a lifetime purchase. See §10.
}

model AliasLink {                          // anonymous RevenueCat id → account
  alias  String  @id
  userId String?
}
```

> If `mock_auth_remote_data_source.dart` holds a field this schema is missing, **the mock wins** —
> share it and I'll reconcile. Nothing in the spec suggests one today.

---

## 4. Response & error helper

Write this once and route every handler through it. Scattered `res.status(x).json(y)` calls are how
rule violations creep in.

```ts
// src/lib/apiError.ts
export type FieldError = { field: string; code: string; message?: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fieldErrors: FieldError[] = [],
  ) { super(code); }
}

// The complete set of codes the client understands.
// Adding one is safe and needs no client release. Renaming one is a breaking change.
export const CODES = {
  email_taken:         () => new ApiError(409, 'email_taken', [{ field: 'email', code: 'email_taken' }]),
  invalid_credentials: () => new ApiError(401, 'invalid_credentials'),
  password_too_short:  () => new ApiError(422, 'invalid_input', [{ field: 'password',   code: 'password_too_short' }]),
  email_invalid:       () => new ApiError(422, 'invalid_input', [{ field: 'email',      code: 'email_invalid' }]),
  invalid_otp:         () => new ApiError(400, 'invalid_otp',   [{ field: 'code',       code: 'invalid_otp' }]),
  otp_expired:         () => new ApiError(400, 'otp_expired',   [{ field: 'code',       code: 'otp_expired' }]),
  invalid_reset_token: () => new ApiError(400, 'invalid_reset_token', [{ field: 'resetToken', code: 'invalid_reset_token' }]),
  too_many_attempts:   () => new ApiError(429, 'too_many_attempts'),
  session_revoked:     () => new ApiError(401, 'session_revoked'),  // ONLY from /auth/refresh
  unavailable:         () => new ApiError(503, 'unavailable'),
} as const;
```

Error body on the wire — both keys optional, **both must be strings when present**:

```jsonc
{ "code": "email_taken",
  "errors": [{ "field": "email", "code": "email_taken", "message": "for your logs only" }] }
```

A number or object in `code`, or in any entry's `message`, makes the client's error parser throw and
the whole response degrades to *"Something went wrong on our side"* — losing every inline field
message. Type the helper so that cannot happen.

`message` is **for your logs only**. Every user-facing word comes from the app's own translation files
in seven languages; anything you send is discarded.

---

## 5. Password rules

- **Minimum 8 characters. No composition rules. No maximum. No truncation.** The server must not be
  stricter than the client — otherwise the app lets a pilgrim submit a password the server refuses,
  and the rejection arrives as a server error instead of an inline rule they could have followed.
- **Use argon2id, not bcrypt.** This is not a preference: **bcrypt silently truncates input at 72
  bytes**, and the spec forbids truncation. Two different long passphrases sharing a 72-byte prefix
  would both unlock the account. Parameters: `memoryCost: 19456, timeCost: 2, parallelism: 1` (OWASP
  floor). If bcrypt is already wired in, SHA-512 pre-hash before hashing, or migrate.
- **Normalize email server-side** with `.trim().toLowerCase()`. The client trims but does **not**
  lowercase, so without this `Pilgrim@x.com` and `pilgrim@x.com` become two accounts.
- On an unknown email at login, still run a dummy argon2 verify against a fixed hash so response
  timing does not reveal account existence.

---

## 6. The eight endpoints

All under `/auth`. **Seven take no `Authorization` header at all**; only `GET /auth/me` does.
`/auth/refresh` and `/auth/logout` deliberately carry none — the refresh token in the body identifies
the session, and routing them through an authenticated client would make a failing refresh trigger a
refresh.

### Shared shapes

```jsonc
// AuthTokens
{ "accessToken": "string",    // required
  "refreshToken": "string",   // required EVEN IF YOU DO NOT ROTATE — echo it back
  "expiresIn": 900 }          // optional, integer seconds

// AuthUser
{ "id": "string",             // required, non-empty, non-blank
  "email": "string",          // required
  "fullName": "string",       // optional, may be null
  "emailVerified": true }     // optional, JSON boolean ONLY

// AuthSession — the body of login, register and refresh
{ "tokens": { }, "user": { } }   // user REQUIRED on login + register; omit on refresh
```

### 6.1 `POST /auth/register`

Request `{ email, password, fullName }` — the `fullName` key is always present, its value may be null.

Success `200` **or** `201` (the client accepts any 2xx): a full `AuthSession`, **`user` required**.

| Case | Status | Body |
|---|---|---|
| Duplicate address | `409` | `{"code":"email_taken","errors":[{"field":"email","code":"email_taken"}]}` |
| Password < 8 | `422` | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}` |
| Address rejected | `422` | `{"code":"invalid_input","errors":[{"field":"email","code":"email_invalid"}]}` |

**Never `429` here. Never `401`/`403` here.** Set `emailVerified: true` — there is no verification flow
in the client, and adding one would be a fifth network-required action, a product decision rather than
an implementation one. The sign-up form requires a terms checkbox but **sends nothing about it**;
there is no terms field in the request.

### 6.2 `POST /auth/login`

Request `{ email, password }`. The password is sent exactly as typed, never trimmed.

Success `200`: a full `AuthSession`, **`user` required**.

Wrong password **and unknown address** both → `401 {"code":"invalid_credentials"}`. A `404` here is a
working account-enumeration oracle: type an address, learn whether that person uses HajjCare.
**Never `429` here.**

### 6.3 `POST /auth/refresh` — the one dangerous endpoint

Request `{ refreshToken }`. No auth header.

Success `200`: `{"tokens":{...}}`. Omit `user`, or send a well-formed one — a malformed `user` fails
the refresh even though the client ignores its contents, and after 45 days of failing refreshes the
pilgrim is asked to sign in again.

| Case | Status | Effect on the pilgrim |
|---|---|---|
| Token genuinely revoked, expired or unknown | `401` + JSON | **Signed out.** The only automatic sign-out in the app |
| Rate limited | `429` | Nothing. Session untouched |
| Maintenance, deploy, dependency down, any unexpected error | `503` | Nothing. Session untouched |

```ts
// Guard this route explicitly. A generic error handler that defaults to 401 signs pilgrims out.
authRouter.post('/refresh', async (req, res) => {
  try {
    const pair = await tokenService.rotate(req.body?.refreshToken);
    if (!pair) return res.status(401).json({ code: 'session_revoked' }); // deliberate, the only one
    return res.status(200).json({ tokens: pair });
  } catch (err) {
    log.error({ err }, 'refresh failed');
    return res.status(503).json({ code: 'unavailable' });   // NEVER 401 for an unexpected error
  }
});
```

**Rotation with a 60-second grace window.** Two independent callers exist — a background refresher (at
launch and on every resume, at most once per six hours) and the 401 interceptor — and they are not
coordinated with each other. Instant invalidation of the old token makes a rare but real race sign a
pilgrim out. So if the presented token was rotated less than 60 seconds ago, return its replacement
pair rather than `401`. If you would rather not rotate at all, that is simpler and safe — echo the same
token back; the field is still required.

### 6.4 `POST /auth/forgot-password`

Request `{ email }`. Success `200` for **every syntactically valid address**, registered or not:

```json
{ "expiresInSeconds": 600, "resendAfterSeconds": 60, "codeLength": 6 }
```

These are **durations remaining from the moment the client receives the response**, not timestamps —
the client renders live countdowns from them. A resend returns a fresh full 600/60, not the remainder
of the old window. `codeLength` must be `6`: the translated copy in all seven languages says "a
six-digit code" in prose.

Must not reveal account existence by status, body **or timing**. Enqueue the email, never await SMTP,
and keep the unknown-address path doing comparable work. This same endpoint is what the Resend button
calls, unchanged. Rate limit with `429 {"code":"too_many_attempts"}` — safe here, the wording fits.
Never `404`.

### 6.5 `POST /auth/verify-otp`

Request `{ email, code }`. `code` is always exactly 6 ASCII digits — the client strips everything else
as it is typed, including Arabic-Indic digits (`٠`–`٩`), so no normalization is needed on your side.

Success `200`: `{ "resetToken": "rst_…", "expiresInSeconds": 600 }` — **a reset token and nothing else.
Never an access token, never a refresh token, never a session.** A verified code is not a login;
issuing one would make password reset a second, weaker way in: six digits and no password at all.

Checked **in this order** — the order is part of the contract:

1. Locked out (5 wrong attempts) → `429 too_many_attempts`. **Check this before the code**, or a
   locked-out pilgrim typing the *right* code gets in and the lockout is decorative.
2. Code expired → `400 otp_expired`. **An expired code must not consume an attempt** — charging one
   punishes a pilgrim for a clock.
3. Wrong code → `400 invalid_otp`.
4. **Unknown address → `400 invalid_otp`**, identical to a wrong code. Never `404`.

Five attempts, not three: these pilgrims are reading six digits off a phone screen in bright sun. A
limiter that locks on the second slip is a support call, not a security control.

**A resend voids the previous code and resets the attempt counter to zero.** The Resend button exists
to rescue a locked-out pilgrim; a lockout that survives a new code makes the button useless for the
person who needs it most. A separate, slower limit on resends themselves is fine and expected (`429`).

### 6.6 `POST /auth/reset-password`

Request `{ resetToken, password }`. Success `204` — **the body is not read**. Return no tokens: the
pilgrim is sent to the sign-in screen to type the password they just chose, which is what proves they
know it.

| Case | Status | Body |
|---|---|---|
| Token invalid, expired or already used | `400` | `{"code":"invalid_reset_token","errors":[{"field":"resetToken","code":"invalid_reset_token"}]}` |
| Password < 8 | `422` | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}` |

Single-use is firm: mark the token consumed in the same transaction as the password update. Revoking
the user's other refresh tokens here is sensible and invisible to the client — those devices simply
fail their next refresh and sign in again.

### 6.7 `POST /auth/logout`

Request `{ refreshToken }`. **Always `204`.** Best-effort and idempotent: an unknown, already-revoked
or already-expired token returns `204`, not an error. The client has already cleared its local session
before this call is made, and the result is only logged — a pilgrim who taps Sign Out in Arafat with
no signal is signed out locally regardless.

**Expect `{"refreshToken": ""}`.** A pilgrim who unticked *Keep me signed in* and has restarted the app
has no refresh token on the device, and signing out still sends this call with an empty string. Answer
`204`; do not `400` or `422` it.

### 6.8 `GET /auth/me`

The only endpoint carrying `Authorization: Bearer <accessToken>`.

Success `200`: a **bare `AuthUser`**, not wrapped in `{"user": …}`.

Expired token → `401` (the client refreshes once and retries; a second `401` fails the call and signs
nobody out). `403` → fails outright, no refresh attempted. Not called by any screen today, but build it
— it costs little and the profile feature will want it.

---

## 7. Tokens

| | Value | Firmness |
|---|---|---|
| Access token | 15 min (`expiresIn: 900`) | proposal — any value works |
| Refresh token | 60 days | **≥45 days is a firm floor** |
| Reset token | 10 min, single-use | single-use firm; duration a proposal |
| OTP code | 10 min · 60s resend cooldown · 6 digits · 5 attempts | `codeLength: 6` firm |

**The client reads no JWT claims.** The access token is an opaque string to it — stored, attached as a
bearer header, compared with itself. `user.id` comes from the response body, never from a `sub` claim.
Use whatever claims your middleware wants; none of them reach the app.

Refresh and reset tokens: 32 random bytes, **sha256-hashed at rest**, never logged.

---

## 8. Express wiring — where this contract actually breaks

Most violations of §1 come from framework defaults, not from handler code. Check every one.

**1. Express's default 404 returns HTML with status 404.** Under `/auth` that renders as *"We could not
find an account for that email address."* A typo in a path becomes a lie about a pilgrim's account:

```ts
authRouter.use((_req, res) => res.status(503).json({ code: 'unavailable' }));  // never 404
```

**2. Router-wide auth middleware.** `authRouter.use(requireAuth)` returns `401` on register,
forgot-password, verify-otp and reset-password — all four then show *"That email and password do not
match"* on screens where no password was typed. Apply `requireAuth` to `/auth/me` **only**.

**3. `express.json()` parse errors** throw a `SyntaxError` the default handler renders as HTML `400`.
Catch it and return `{"code":"invalid_input"}` as JSON.

**4. The global error handler must never default to 401, 403, 404 or 409.** Default to `503` with
`{"code":"unavailable"}`. Log the real error; send only the code.

**5. `express-rate-limit` defaults to `429` on whatever you mount it on.** Mount it on
forgot-password, verify-otp and refresh. **Never on login or register.**

**6. Reverse proxies and platforms return their own errors.** Nginx, Cloudflare, ALB and Heroku all emit
HTML `404` and `502` pages, and **the client classifies `404`, `409` and `429` by status alone — an
empty or non-JSON body does not save you.** Make sure nothing in front of this API can return a bare
`404` on the API hostname, and that no API-gateway auth sits in front of `/auth/refresh`.

**7. Do not put `express.json()` in front of the RevenueCat webhook route** — the HMAC is computed over
raw bytes (§10).

**8. No redirects.** No trailing-slash redirect middleware, no HTTP→HTTPS redirect the app could hit.
The client follows nothing and sends no cookies.

**9. Serialize `user.id` as a string.** If integer primary keys ever appear, cast at the boundary — a
bare JSON integer fails the parse and no session is created.

**10. `emailVerified` must be a JSON boolean.** Some drivers return `1`/`0` from a tinyint column. Fine
with Prisma + Postgres; verify it in the conformance test anyway (§12).

Correct order in `app.ts`:

```ts
app.use(requestId);
app.use('/webhooks/revenuecat', express.raw({ type: 'application/json' }), webhookRouter); // BEFORE json
app.use(express.json({ limit: '32kb' }));
app.use(jsonParseErrorHandler);       // SyntaxError → 400 {code:'invalid_input'}
app.use('/auth', authRouter);         // requireAuth lives on /auth/me alone
authRouter.use(authNotFound);         // 503, never 404
app.use(globalErrorHandler);          // default 503, never 401/403/404/409
```

---

## 9. Email

One transactional email in Phase 1: the six-digit OTP.

- **Enqueue and return immediately.** The client's receive timeout is 15 seconds; awaiting SMTP makes
  forgot-password indistinguishable from being offline.
- **The language is currently unknowable.** The app ships in seven languages but **sends no
  `Accept-Language` header and no locale field today**. Write the email in English for now and raise it
  with the Flutter dev — localising it needs either a header or a field on `/auth/forgot-password`,
  which means a client release. Worth deciding before Hajj season.
- Never log the code; store only its sha256.
- Put the provider behind an `EmailProvider` interface. In dev, write to `/tmp/emails/` instead of sending.

---

## 10. RevenueCat webhook — Phase 2

`POST /webhooks/revenuecat`. **Nothing here is on the client's critical path.** The app talks to
RevenueCat directly and writes entitlement to its own local database; a webhook endpoint that is down
cannot stop a pilgrim buying, restoring or using the app. Build it for support, records and refunds.

- **Verify HMAC-SHA256** from `X-RevenueCat-Webhook-Signature: t=<ts>,v1=<hex>`, computed over
  `"<t>.<raw body>"`, compared in constant time, with a 5-minute timestamp tolerance. **Over raw bytes,
  before any JSON parsing** — re-serializing a parsed object changes the bytes and every valid request
  then fails verification.
- **Return `200` specifically** (not any 2xx) within 60 seconds, as soon as the event is durably stored;
  process on a queue. RevenueCat retries 5 times at 5/10/20/40/80 minutes — the whole window is under
  three hours, so durable storage on first delivery matters more, not less.
- **Idempotency via a unique constraint on `event.id`.** Required, not advisory.
- **Key on `entitlement_ids` containing `hajjcare_pass`, read from config. Never hardcode `product_id`**
  — the real SKU has not been chosen yet, and a rule written against it breaks silently the day it is.
- **`app_user_id` may be `$RCAnonymousID:…` for a real, paid purchase.** The client gives up on
  `Purchases.logIn` after 15 seconds and carries on, and signing out moves the device to a fresh
  anonymous id. **Store those events, never drop them**, and match on **any** id in `aliases`, not on
  `app_user_id` alone. No `TRANSFER` event fires for aliasing — do not wait for one.
- **Only `CANCELLATION` with `cancel_reason: "CUSTOMER_SUPPORT"` revokes.** Every other reason is
  ignored. Treating a bare `CANCELLATION` as a refund revokes a pilgrim who paid.
- **`expiration_at_ms` is always null. Do not write an expiry column, compute one, or build a sweeper.**
  The pass is a lifetime purchase.
- **An unrecognised `type` → store it and return `200`**, never an error. Handle `TEST` first; it is the
  first button anyone presses while wiring this up.
- Never grant on `environment: "SANDBOX"` in production.
- **Support must be able to search by email**, not by UUID — an agent has an address in front of them.

Be clear-eyed: your revocation does not reach the handset. The client's only deactivation method has no
production caller, deliberately, because a store call that fails in Mina must not take a paying
pilgrim's medication alarms away. Recording the refund is still worth doing; closing that gap is a new
design, not a webhook handler.

---

## 11. Family groups — Phase 3, do not start yet

BACKEND_SPEC.md §6c specifies six authenticated endpoints. **Nothing in the app consumes any of them
today** — the Family tab renders an honest empty state. Three rules to carry forward when it starts:

- **Consent is enforced server-side.** A member who has not agreed to share location is returned with
  `presence: null` — never a position the client is trusted to hide. A client-side filter over a payload
  that already contains the coordinates is not a permission; it is a suggestion that ships in an APK
  anybody can unpack.
- **`reportedAt` is stamped from the server's clock**, and the client always renders the *age*. A family
  member reading "200m away" about someone who last reported six hours ago is being told something false
  at the moment it matters most.
- **Do not add a `status` / "Safe" field.** Nothing in the product defines what would produce it, and a
  badge asserting a person is safe with no source is the worst thing on that screen.

---

## 12. Conformance tests — the definition of done

`scripts/verify-contract.sh` (shipped alongside this file) runs these against a live server. **Run it
green before giving the app dev a base URL.** Mirror each as a Vitest + Supertest test in
`tests/contract/`.

**Shape** — every 2xx body is a top-level JSON object with no `data`/`success` wrapper · `user.id` is a
non-empty string · `emailVerified` is a JSON boolean, not `1` or `"true"` · `expiresIn` is a number, not
`"900"` · `/auth/me` returns a bare user, not `{"user":…}`.

**Status discipline** — no route under `/auth` returns `404` for **any** path, including
`/auth/does-not-exist` · `409` appears only on duplicate registration · `429` never appears on login or
register, even after 20 rapid attempts · register, forgot-password, verify-otp and reset-password never
return `401` or `403` under any input.

**Refresh** — a valid token rotates and returns `refreshToken` · the previous token still works inside
60 seconds · outside it, `401` with JSON · a malformed request body returns `503`, never `401` · the
route returns `429`/`503` under load, never `401`.

**Reset flow** — forgot-password returns byte-identical `200` bodies for a registered and an
unregistered address, in comparable time · verify-otp with a wrong code → `400 invalid_otp` · unknown
address → `400 invalid_otp`, never `404` · an expired code does not increment attempts · the 6th wrong
attempt → `429`, checked before the code · a resend voids the old code and resets attempts · verify-otp
returns a reset token and **no** access or refresh token · the reset token is refused the second time ·
reset-password returns `204` with no body.

**Logout** — `{"refreshToken":""}` → `204` · an unknown token → `204` · a revoked token → `204`.

**Passwords** — an 8-character password is accepted · a 7-character one returns `422` with field
`password` = `password_too_short` · a 200-character passphrase is accepted and **still authenticates**
(this is the bcrypt-truncation test) · `Pilgrim@x.com` and `pilgrim@x.com` are the same account.

---

## 13. Environment

```bash
PORT=  NODE_ENV=  DATABASE_URL=  REDIS_URL=
JWT_ACCESS_SECRET=                 # ≥32 bytes; the process exits if missing
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=60          # ≥45, firm
REFRESH_ROTATION_GRACE_SECONDS=60
OTP_TTL_SECONDS=600  OTP_RESEND_COOLDOWN_SECONDS=60  OTP_LENGTH=6  OTP_MAX_ATTEMPTS=5
RESET_TOKEN_TTL_SECONDS=600
PASSWORD_MIN_LENGTH=8
EMAIL_PROVIDER=  EMAIL_API_KEY=  EMAIL_FROM=
REVENUECAT_WEBHOOK_SECRET=  HAJJCARE_ENTITLEMENT_ID=hajjcare_pass
LOG_LEVEL=info
```

Pino redaction: `req.body.password`, `req.body.code`, `req.body.refreshToken`, `req.body.resetToken`,
`req.headers.authorization`, `*.email`.

---

## 14. Questions to send the Flutter dev before building

BACKEND_SPEC.md §8 lists 20 open assumptions. These are the ones that change server code, so answer
them first:

1. **`429` on login/register** — currently forbidden by the wording. If brute-force protection is
   wanted it needs a new error code and a translated message in seven languages. (§8 item 18)
2. **`attemptsRemaining` on `invalid_otp`** — the client has the message translated but parses nothing
   today. Cheap to send, a real usability win for elderly users, a small enumeration signal. (§8 item 14)
3. **OTP email language** — no `Accept-Language` header and no locale field is sent today, so localised
   emails are impossible without a client release. (§8 item 17)
4. **Distinguish "no account for that email" at login?** — a real `AuthFailure` case exists, but using it
   is an enumeration oracle. (§3.4)
5. **`201` vs `200` on register** — the client accepts either; pick one and write it down.
6. **Rotate or not** — rotation with the 60s grace is assumed here; not rotating is simpler and safe.
7. **Confirm `/auth/logout` revokes one refresh token**, not all devices. Per-device tokens now make a
   future "sign out everywhere" cheap; one shared token makes it impossible.