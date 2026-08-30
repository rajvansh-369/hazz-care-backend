# HajjCare — Backend API Specification

**Audience:** the developer (and the AI assistant) building the Node.js service this Flutter client
talks to.

**Status:** derived from the client as it exists today, at commit `040b977`. Every shape below is
what the app already serializes, sends, parses and switches on — not an idealised API. Where the
client would break on a wrong guess, that is called out inline. Where a value is a proposal rather
than a constraint, it is in **§8 Open questions**.

**Source of truth in the client, if you need to check something:**

| What                                           | File                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Request/response JSON shapes                   | `lib/features/auth/data/auth_api_models.dart`              |
| Paths and the endpoint list                    | `lib/features/auth/data/auth_remote_data_source.dart`      |
| Which client (public/authenticated) sends what | `lib/features/auth/data/auth_remote_data_source_impl.dart` |
| Status → failure classification                | `lib/core/services/network/api_failure_mapper.dart`        |
| Error-code → UI behaviour                      | `lib/features/auth/domain/auth_failure.dart`               |
| Timeouts, base URL                             | `lib/core/services/network/api_config.dart`                |
| Reference implementation of every rule below   | `lib/features/auth/data/mock_auth_remote_data_source.dart` |

The mock data source is a working, behaviour-complete implementation of this spec. If a question
here is unanswered, that file is the tiebreaker.

---

## 1. Context

HajjCare is a health companion app for Hajj and Umrah pilgrims: a health passport, medication
alarms, heat and hydration monitoring, ritual tracking, and family sharing. The primary demographic
is elderly. It ships in seven languages (`en`, `ar`, `ur`, `id`, `fr`, `bn`, `tr`), two of them
right-to-left. It is sold as a one-off **lifetime** purchase, not a subscription: one payment,
permanent access, no expiry and no repurchase for a later season. The client stores health data
locally in Drift (SQLite) and tokens in the platform keystore (Keychain / Android Keystore).
**Health data does not leave the device** unless the pilgrim has explicitly turned sharing on, so
there is no health-data endpoint in this document and no endpoint in this document should ever grow
one without that conversation happening first.

**Entitlement is not this API's concern and must not become one.** The pass is bought through the
app stores, and the client records it in its own local database; the route gate that decides whether
a pilgrim may use the app reads that local row and never asks a server. So: no entitlement endpoint,
no receipt-verification call from the client, no expiry date to serve, and nothing here that a
pilgrim's access can depend on. If store-side receipt validation is added later it is a server-to-
store concern that the client never waits on.

The app is **offline-first, and this is a safety requirement rather than a nicety.** Pilgrims lose
all connectivity for days at a time in Mina, Arafat and Muzdalifah — an app that locks them out
there has taken away their medication alarms, their health passport and their emergency button.
Exactly **four user actions may require a network: sign in, sign up, password reset (send code,
verify OTP, resend, set new password), and purchase/restore.** Everything else — every relaunch,
profile setup, every screen — works with the radio off. Two consequences shape this entire API.
First, **once the client holds a session it never asks the server whether that session is still
valid**; validity is decided from local state, and the app treats a stored session as good for 45
days without a single successful refresh. Second, **a failed request must never cost the pilgrim
their access.** A timeout, a 401, a 5xx and a hotel captive portal are all the same answer to this
client — _nothing happened_ — and there is exactly one exception, documented in §4. Design your
error handling knowing the client will not log anybody out for you, and must not be relied on to.

---

## 2. Stack expectations

The client is agnostic to how you build this: Express, Fastify, NestJS, Postgres, Prisma, whatever
you prefer. Nothing in the app knows or cares. What the client's behaviour _does_ pin down:

- **JSON in, JSON out.** The client sends `Content-Type: application/json` and
  `Accept: application/json` on every request, and sets `responseType: json`.
- **Every response body that the client parses must be a JSON object at the top level.** There is no
  envelope. `{"tokens": {...}, "user": {...}}` is correct; `{"data": {"tokens": ...}}` is not — the
  client reads `tokens` off the root and a wrapped body fails to parse and surfaces as a server
  error. This applies to `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/forgot-password`,
  `/auth/verify-otp` and `/auth/me`. `/auth/reset-password` and `/auth/logout` bodies are not read
  at all.
- **camelCase keys throughout**, request and response. The client's DTOs are generated with
  camelCase field names. (snake_case is a one-line client change but a coordinated one — see §8.)
- **JWT bearer auth.** The client sends `Authorization: Bearer <accessToken>`. The token is
  **opaque to the client** — nothing in the app decodes it or reads any claim (verified: there is no
  JWT decoding anywhere in `lib/`). Use JWTs, use opaque strings; the client cannot tell.
- **Stable machine-readable error codes.** Screens switch on a string `code`, never on a message.
  See §3.2. Human-readable text from the server is used for logs only — all user-facing wording
  comes from the app's own translation files.
- **Timeouts: connect 10s, send 15s, receive 15s.** Anything slower than that is indistinguishable
  from being offline. In particular `/auth/forgot-password` must **enqueue** the email and answer
  immediately rather than waiting on SMTP.
- **HTTPS.** No cookies, no CSRF tokens, no redirects, no session affinity — the client sends a
  bearer header and nothing else.

**Base URL** is injected at build time and includes any version segment:

```bash
flutter run --dart-define=HAJJCARE_API_BASE_URL=https://api.hajjcare.example/v1
```

Paths below are appended to it verbatim, so `/auth/login` becomes
`https://api.hajjcare.example/v1/auth/login`.

---

## 3. Endpoints

Eight endpoints, all under `/auth`. Six take no authentication at all; only `GET /auth/me` carries a
bearer token.

| Method | Path                    | Auth header | Purpose                                 |
| ------ | ----------------------- | ----------- | --------------------------------------- |
| POST   | `/auth/register`        | no          | Create account, return a session        |
| POST   | `/auth/login`           | no          | Return a session                        |
| POST   | `/auth/refresh`         | no          | Exchange a refresh token for a new pair |
| POST   | `/auth/forgot-password` | no          | Email a one-time code                   |
| POST   | `/auth/verify-otp`      | no          | Exchange a code for a reset token       |
| POST   | `/auth/reset-password`  | no          | Set a new password with a reset token   |
| POST   | `/auth/logout`          | no          | Invalidate a refresh token              |
| GET    | `/auth/me`              | **yes**     | Current account                         |

`/auth/refresh` and `/auth/logout` deliberately carry **no** `Authorization` header: the refresh
token in the body is what identifies the session, and routing them through the authenticated client
would make a failing refresh trigger a refresh.

### 3.1 Shared response objects

Three objects recur. Their keys are fixed by the client's parser.

```jsonc
// AuthTokens
{
  "accessToken": "string", // required
  "refreshToken": "string", // required — see §4, required even when you do not rotate
  "expiresIn": 900, // optional, integer SECONDS, access-token lifetime
}
```

```jsonc
// AuthUser
{
  "id": "string", // required, stable, non-empty — see the warning below
  "email": "string", // required
  "fullName": "string", // optional, may be null
  "emailVerified": true, // optional, defaults to false when absent
}
```

```jsonc
// AuthSession — the body of login, register and refresh
{
  "tokens": {/* AuthTokens */}, // required
  "user": {/* AuthUser   */}, // required on login and register; optional on refresh
}
```

> **`user.id` is the Drift primary key for everything the pilgrim owns.** It must be stable for the
> life of the account and identical across login, register, refresh and `/auth/me`. If it ever
> changes for an existing account, that pilgrim's local health passport and medication schedule
> stop being associated with them. Never reuse an id across accounts.

> **`user` is required on login and register.** The client throws a parse error (surfaced as a
> server failure, no session created) if a login or register response has no `user`. On `/auth/refresh`
> it is optional and normally omitted — the session being renewed already knows whose it is.

### 3.2 Error responses — the shape and the codes

Every non-2xx response should carry a JSON object of this shape. Both keys are optional; `errors`
may also be spelled `fieldErrors`.

```jsonc
{
  "code": "email_taken", // top-level machine code
  "errors": [
    // per-field codes
    { "field": "email", "code": "email_taken", "message": "for your logs only" },
  ],
}
```

**How the client classifies a response, before it looks at any code:**

| Status                                            | Client's classification | Effect                                                                                                                                 |
| ------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx                                               | success                 | body parsed                                                                                                                            |
| **401 / 403**                                     | unauthorized            | on `/auth/login` → "wrong email or password"; on `/auth/refresh` → **session revoked, see §4**; elsewhere → one silent refresh + retry |
| other 4xx                                         | validation failure      | `code`/`errors` are read, see the table below                                                                                          |
| 5xx, or an unparseable body                       | server failure          | retryable, session untouched                                                                                                           |
| no response at all (timeout, DNS, dropped socket) | offline                 | **nothing changes**, no sign-out, no redirect                                                                                          |

Note that **`code` is ignored on 401 and 403** — those are classified by status alone. Send one
anyway for your logs, but do not rely on the client reading it.

**Codes the client understands**, in the order it tests them. The order matters: the first match
wins, so a 429 that also carries `"code": "invalid_otp"` is treated as a lockout, not a wrong code.

| #   | Condition                                                                            | Client behaviour                                                                   |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | status `409`, or `code: "email_taken"`, or field `email` = `email_taken`             | "That email already has an account"                                                |
| 2   | `code: "invalid_credentials"`                                                        | "Wrong email or password"                                                          |
| 3   | status `404`, or `code: "account_not_found"`, or field `email` = `account_not_found` | "No account for that email"                                                        |
| 4   | `code: "invalid_reset_token"`, or field `token`/`resetToken` = `invalid_reset_token` | "That reset has expired, start again"                                              |
| 5   | status `429`, or `code: "too_many_attempts"`                                         | "Too many tries, wait, then ask for a new code"                                    |
| 6   | `code: "otp_expired"`, or field `code` = `otp_expired`                               | "That code has expired, ask for a new one"                                         |
| 7   | `code: "invalid_otp"`, or field `code` = `invalid_otp`                               | "That code is not right, check the digits"                                         |
| 8   | anything else 4xx                                                                    | field codes routed under their fields; unknown codes fall back to a generic banner |

Field code `password_too_short` on field `password` is routed under the password input on both
registration and the reset-password form.

> **Two traps that follow from rows 1 and 3, and they are the ones most likely to bite you:**
>
> - **Never return a bare `404` from anything under `/auth`, including for an unknown route or a
>   typo'd path.** Any 404 is rendered to the pilgrim as _"We could not find an account for that
>   email address."_ A missing route would tell a pilgrim their account does not exist.
> - **Never return `409` from an `/auth` endpoint for anything except a duplicate registration.** Any
>   409 is rendered as _"That email already has an account."_
>
> For rate limiting, maintenance and infrastructure errors use `429` and `503`. Both are safe:
> neither clears a session.

Unknown codes are safe — the client degrades to a generic message rather than crashing, so you can
add codes without a client release. Changing or removing an existing one is a breaking change (§7).

---

### 3.3 `POST /auth/register`

**Request**

```jsonc
{
  "email": "string", // required
  "password": "string", // required
  "fullName": "string", // key ALWAYS present; value may be null
}
```

| Field      | Client already enforces                                         | Server must match                                                                                                  |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `email`    | non-empty, trimmed, matches `^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$`   | may be stricter about deliverability, but a pilgrim who registered with an address must be able to sign in with it |
| `password` | **min 8 characters, any characters, no maximum**                | **must not be stricter.** No composition rules, no truncation. See the note below                                  |
| `fullName` | trimmed, min 2 characters, always sent non-null by the UI today | treat as optional; the DTO permits null                                                                            |

> The 8-character, composition-free rule is a deliberate choice for elderly users typing on a phone
> keyboard, often in a second script, and it matches NIST SP 800-63B's floor. A server stricter than
> the client means the app lets a pilgrim submit a password the server then refuses — the rejection
> arrives as a server error instead of an inline rule they could have followed before typing it.
> There is no maximum: a passphrase is a good password and silently truncating one makes it a bad one.

**Success — `200` or `201`**

```json
{
  "tokens": { "accessToken": "eyJ...", "refreshToken": "def502...", "expiresIn": 900 },
  "user": {
    "id": "3f9a...",
    "email": "pilgrim@example.com",
    "fullName": "Aisha Rahman",
    "emailVerified": true
  }
}
```

`user` is **required** here.

**Errors**

| Case                           | Status | Body                                                                                   | Client shows                                                                          |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Address already registered     | `409`  | `{"code":"email_taken","errors":[{"field":"email","code":"email_taken"}]}`             | banner: already has an account                                                        |
| Password below the minimum     | `422`  | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}` | inline, under the password field                                                      |
| Address rejected by the server | `422`  | `{"code":"invalid_input","errors":[{"field":"email","code":"email_invalid"}]}`         | inline, under the email field (any `email` code that is not `email_taken` lands here) |
| Server broke                   | `5xx`  | any                                                                                    | retryable banner                                                                      |

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/register \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"pilgrim@example.com","password":"correct horse battery","fullName":"Aisha Rahman"}'
```

---

### 3.4 `POST /auth/login`

**Request**

```jsonc
{ "email": "string", "password": "string" } // both required
```

`email` is trimmed by the client but **not lowercased** — match addresses case-insensitively on your
side. `password` is sent exactly as typed, never trimmed.

**Success — `200`**: identical shape to register. `user` is **required**.

**Errors**

| Case                               | Status | Body                             | Client shows              |
| ---------------------------------- | ------ | -------------------------------- | ------------------------- |
| Wrong password, or unknown address | `401`  | `{"code":"invalid_credentials"}` | "Wrong email or password" |
| Server broke                       | `5xx`  | any                              | retryable banner          |

> **Return `401` for an unknown address too, not `404`.** A `404` here is a working account-enumeration
> oracle: type an address, learn whether that person uses HajjCare. The client _can_ render a distinct
> "no account for that email" (it is a real case in `AuthFailure`), so use it only if you have
> decided the enumeration trade-off is worth it — see §8.
>
> **Do not `429` this endpoint.** The client's rate-limit message is written for the OTP screen
> ("wait, then ask for a new code") and reads as nonsense on a sign-in form. If you need brute-force
> protection here, see §8 — it needs a new code and a client change.

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/login \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"pilgrim@example.com","password":"correct horse battery"}'
```

---

### 3.5 `POST /auth/refresh`

The most safety-critical endpoint in the API. Read §4 before implementing it.

**Request**

```jsonc
{ "refreshToken": "string" } // required
```

No `Authorization` header. Sent by two independent callers: a background refresher (roughly every
six hours, unawaited, nothing waits for it) and the 401 interceptor (single-flight — concurrent 401s
share one refresh call).

**Success — `200`**

```json
{ "tokens": { "accessToken": "eyJ...", "refreshToken": "def502...", "expiresIn": 900 } }
```

`user` may be included but is normally omitted; the client carries the existing identity forward.
**`tokens.refreshToken` is required even if you do not rotate** — omit it and the response fails to
parse. If you do not rotate, echo the same token back.

**Errors**

| Case                                           | Status | Body                                                                                      | Client behaviour                                                                               |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Refresh token genuinely revoked or expired** | `401`  | **JSON object**, e.g. `{"code":"session_revoked"}`, with `Content-Type: application/json` | **Clears the session and signs the pilgrim out.** The only automatic sign-out in the whole app |
| Rate limited                                   | `429`  | `{"code":"too_many_attempts"}`                                                            | call fails, **session untouched**                                                              |
| Maintenance / server error                     | `5xx`  | any                                                                                       | call fails, **session untouched**                                                              |
| Unreachable, timeout, captive portal           | —      | —                                                                                         | call fails, **session untouched**                                                              |

> **A `401` here is the one thing in this API that can end a pilgrim's session.** Return it only
> when the token is genuinely dead — revoked, expired, or unknown. Never for rate limiting, never
> during a deploy, never as a generic error. The client additionally requires the body to be this
> API's own JSON (a captive portal's HTML 401 is ignored on purpose), so a bare `401` with no JSON
> body will _not_ sign anyone out — but do not lean on that as a safety net.

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/refresh \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"refreshToken":"def502..."}'
```

---

### 3.6 `POST /auth/forgot-password`

**Request**

```jsonc
{ "email": "string" } // required, trimmed by the client
```

**Success — `200`.** Returned for **every** syntactically valid address, registered or not.

```json
{ "expiresInSeconds": 600, "resendAfterSeconds": 60, "codeLength": 6 }
```

All three keys are optional and default to exactly these values client-side, but **send them** — the
code screen renders live countdowns from them (§5).

They are **durations remaining, anchored to the moment the client receives the response**, not
absolute timestamps. The client's clock and yours disagree; this is deliberate. A resend returns a
fresh full duration, not what is left of the old one.

**Errors**

| Case            | Status                | Body                           | Client behaviour                                                                             |
| --------------- | --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Unknown address | **`200`** — see below | same as success                | proceeds to the code screen, identically                                                     |
| Resend abuse    | `429`                 | `{"code":"too_many_attempts"}` | "Too many tries, wait, then ask for a new code"                                              |
| Server broke    | `5xx`                 | any                            | retryable banner — the pilgrim is _not_ sent to a code screen for a code that was never sent |

> **Must not reveal whether an account exists** — not by status, not by body, not by timing. The
> client defends itself as well (an `account_not_found` on this endpoint is folded into a success),
> but the defence does not cover response timing, so do the constant-time work on your side:
> enqueue the mail, do not await SMTP, and return the same body in the same time for an unknown
> address as for a real one.

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/forgot-password \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"pilgrim@example.com"}'
```

---

### 3.7 `POST /auth/verify-otp`

**Request**

```jsonc
{
  "email": "string", // required — six digits identify nobody; verify the pair
  "code": "string", // required, trimmed, digits as typed (e.g. "123456")
}
```

Client-side the code must be non-empty and exactly `codeLength` characters before a request is made.

**Success — `200`**

```json
{ "resetToken": "rst_9f3c...", "expiresInSeconds": 600 }
```

**A reset token and nothing else. Never an access token, never a refresh token, never a session** —
the client's response type has no field to put one in, and a verified code is not a login. See §6.

**Errors** — checked in this order, which matters:

| Case                              | Status | Body                                                                      | Client shows                                    |
| --------------------------------- | ------ | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Locked out (too many wrong codes) | `429`  | `{"code":"too_many_attempts"}`                                            | "Too many tries, wait, then ask for a new code" |
| Code expired                      | `400`  | `{"code":"otp_expired","errors":[{"field":"code","code":"otp_expired"}]}` | "That code has expired, ask for a new one"      |
| Wrong code                        | `400`  | `{"code":"invalid_otp","errors":[{"field":"code","code":"invalid_otp"}]}` | "That code is not right, check the digits"      |
| Unknown address                   | `400`  | `{"code":"invalid_otp"}`                                                  | same as a wrong code — **never `404`**          |

> **Check the lockout before the code**, so a locked-out pilgrim typing the _right_ code is still
> told to wait. Otherwise the lockout is decorative.
>
> **An expired code must not consume an attempt.** Charging one punishes a pilgrim for a clock.

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/verify-otp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"pilgrim@example.com","code":"123456"}'
```

---

### 3.8 `POST /auth/reset-password`

**Request**

```jsonc
{
  "resetToken": "string", // required — the token from verify-otp, not a session token
  "password": "string", // required, min 8 chars, same rule as registration
}
```

**Success — `204`** (or any 2xx). **The response body is not read.** Do not return tokens here: the
pilgrim is sent to the sign-in screen to type the password they just chose, which is what proves
they know it.

**Errors**

| Case                                    | Status | Body                                                                                            | Client shows                          |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| Token invalid, expired, or already used | `400`  | `{"code":"invalid_reset_token","errors":[{"field":"resetToken","code":"invalid_reset_token"}]}` | "That reset has expired, start again" |
| Password below the minimum              | `422`  | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}`          | inline, under the password field      |

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/reset-password \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"resetToken":"rst_9f3c...","password":"a new long password"}'
```

---

### 3.9 `POST /auth/logout`

**Request**

```jsonc
{ "refreshToken": "string" } // required
```

No `Authorization` header. **Success — `204`** (or any 2xx); the body is not read.

**The client has already cleared its local session before this call is made**, and the result is
only logged. A pilgrim who taps Sign Out in Arafat with no signal is signed out locally regardless.

Consequences for you: this endpoint is **best-effort and must be idempotent**. An unknown, already-
revoked or already-expired refresh token should return `204`, not an error — there is nothing the
client can do with the failure, and nothing it will do.

**curl**

```bash
curl -X POST https://api.hajjcare.example/v1/auth/logout \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"refreshToken":"def502..."}'
```

---

### 3.10 `GET /auth/me`

The **only** endpoint that carries `Authorization: Bearer <accessToken>`.

**Request:** no body.

**Success — `200`**

```json
{
  "id": "3f9a...",
  "email": "pilgrim@example.com",
  "fullName": "Aisha Rahman",
  "emailVerified": true
}
```

A bare `AuthUser` — **not** wrapped in `{"user": ...}`.

**Errors**

| Case                 | Status | Client behaviour                                                                                                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Access token expired | `401`  | the interceptor refreshes **once** and retries the request automatically. A second `401` fails the call — and **does not sign anyone out** |
| Forbidden            | `403`  | fails immediately, no refresh attempted (a new token would not help)                                                                       |
| Server broke         | `5xx`  | fails, retryable                                                                                                                           |

> Implemented in the client but **not called by any screen today**. Build it — it costs little and
> the profile feature will want it — but nothing is currently blocked on it.

**curl**

```bash
curl https://api.hajjcare.example/v1/auth/me \
  -H 'Accept: application/json' -H 'Authorization: Bearer eyJ...'
```

---

## 4. Auth model

### What the client stores and for how long

On a successful login or register the client writes the access token and refresh token to the
platform keystore, stamps the time **from its own clock** (not yours — a skewed server must not be
able to shorten a pilgrim's offline window), and from that moment treats the session as valid
locally.

**A local session is valid for 45 days without a single successful refresh.** A Hajj trip runs about
40 days; the window has room either side. Every successful refresh resets the 45 days.

### The client never asks whether the session is valid

There is no "validate session" call, and there is no code path anywhere in the app that ends a
session because a request failed. Specifically:

- **A `401` on any endpoint other than `/auth/refresh` never signs anybody out.** It triggers one
  silent refresh and one retry. If that fails, the _request_ fails. The session stays.
- **A timeout, a DNS failure, a dropped socket, a captive portal, a `5xx`: nothing happens.** The
  session stays, the pilgrim stays where they are, and no login screen appears.
- **Do not build any flow that assumes the client will log out when you reject it.** If you need a
  session gone, revoke the refresh token and wait for the next refresh (§ below). If you need it
  gone _now_, that is a feature that does not exist yet and needs designing — it cannot be bolted on
  by returning 401s.

This is not a preference. A pilgrim locked out of the app in Mina has lost their medication alarms
and their emergency button, days from a working data connection, and cannot recover without one.

### Token lifetimes the client assumes

|                               | Value                             | How firm                                                                                                |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Access token                  | **15 minutes** (`expiresIn: 900`) | proposal — the client works with any value, see §8                                                      |
| Refresh token                 | **at least 45 days**, 60 proposed | **firm floor.** Shorter than 45 days and a pilgrim offline for a full Hajj comes home to a dead session |
| Reset token (from verify-otp) | **10 minutes**                    | proposal, must be minutes not hours                                                                     |
| OTP code                      | **10 minutes**                    | see §5                                                                                                  |

`expiresIn` is **optional** and in **seconds**. When absent the client records the lifetime as
"unknown", which it treats as "try the call and let a 401 sort it out" — never as "already expired".
Nothing on the launch path reads it.

### Rotation

**Rotation is expected and supported.** The client persists whatever `refreshToken` comes back from
`/auth/refresh` before any queued retry can read the old one, and its refresh is single-flight
precisely so that six simultaneous 401s cannot spend one refresh token six times.

- **If you rotate:** the old token should keep working for a short grace window (60 seconds
  proposed) returning the current pair, rather than being invalidated instantly. Two independent
  client callers exist — the background refresher and the 401 interceptor — and they are not
  coordinated with each other. Instant invalidation makes a rare but real race sign a pilgrim out.
- **If you do not rotate:** echo the same `refreshToken` back in every refresh response. The field
  is required.

### The one condition that may end a session

> **`POST /auth/refresh` answering `401` (or `403`) with a `Content-Type: application/json` body
> that is a JSON object.**

That is the complete list. The client requires both the status _and_ the JSON, because a hotel or
airport captive portal answers `401` with an HTML sign-in page and believing it would sign a pilgrim
out for connecting to the wifi.

Use it for a genuine revocation — password changed elsewhere, account disabled, token explicitly
revoked. Never for load shedding, deploys, or rate limiting.

### JWT claims the client reads

**None.** The access token is an opaque string to this client: it is stored, attached as a bearer
header, and compared for equality with itself. Nothing decodes it, so no claim you add will change
client behaviour, and no claim you rename will break it. `user.id` comes from the response body, not
from a `sub` claim.

You still want the usual claims (`sub`, `iat`, `exp`, `jti`) for your own middleware — just don't
expect the client to honour anything expressed only in the token.

---

## 5. OTP rules

The client renders **live countdowns from your numbers**, so these values are a contract, not
guidance. If the server's real expiry is 5 minutes and it reports 600 seconds, the screen counts
down from ten minutes and the code dies with five minutes still showing on it.

| Rule               | Value             | Where it shows in the UI                                              |
| ------------------ | ----------------- | --------------------------------------------------------------------- |
| Code length        | **6 digits**      | six input boxes, sized from `codeLength`                              |
| Code lifetime      | **600s (10 min)** | "This code expires in 9:58." — ticks every second                     |
| Resend cooldown    | **60s**           | "Resend code in 0:47" — the button stays tappable and states the wait |
| Max wrong attempts | **5**, then lock  | "Too many tries. Wait a moment, then ask for a new code."             |

Additional behaviour the client depends on:

- **`codeLength` must be 6.** The screen sizes its boxes from your value, but the app's translated
  copy in all seven languages says "a six-digit code" in prose. Sending 4 or 8 makes the text lie in
  every locale.
- **A resend voids the previous code and resets the attempt counter to zero.** The client's Resend
  button exists to rescue a locked-out pilgrim; if a lockout survives a new code, the button does
  nothing for the person who needs it most. (A separate, slower limit on _resends themselves_ is
  fine and expected — answer those with `429`.)
- **Check the lockout before checking the code** (§3.7).
- **An expired code does not consume an attempt** (§3.7).
- **Five, not three.** These pilgrims are reading six digits off a phone screen in bright sun. A
  limiter that locks on the second slip is a support call, not a security control.
- **Send the durations on every response, including resends** — a resend returns a full fresh
  600/60, not the remainder of the old window.

The client has a message ready for "N tries left before you need a new code" but **does not parse an
attempts counter from the wire today** — see §8 if you want to send one.

---

## 6. Password reset flow

Four calls, in order:

```
POST /auth/forgot-password  { email }
      → 200 { expiresInSeconds, resendAfterSeconds, codeLength }   // identical for every address
POST /auth/verify-otp       { email, code }
      → 200 { resetToken, expiresInSeconds }                       // a reset token, nothing else
POST /auth/reset-password   { resetToken, password }
      → 204                                                        // no tokens in the response
   ... the pilgrim is sent to the sign-in screen and signs in normally
```

### The reset token is scoped to one password change, and is never a session

`POST /auth/verify-otp` returns **a short-lived, single-use token scoped to setting a password on
that one account.** It must not be accepted as a bearer token anywhere, must not carry a session,
and must be invalidated the moment it is spent (and on a second attempt, refused with
`invalid_reset_token`).

Issuing a real session from a verified code would turn password reset into a second, weaker way to
sign in: six digits and no password at all. The client makes this hard to get wrong — the response
type it parses has no field for an access or refresh token — but the rule is yours to enforce.

Likewise `POST /auth/reset-password` returns **no tokens**. Changing a password does not sign anyone
in; typing the new password on the sign-in screen is what proves they know it.

### The endpoint must not reveal whether an account exists

`POST /auth/forgot-password` shows the pilgrim an identical confirmation either way — the app's own
copy is worded _"If pilgrim@example.com has a Hajj Care account, a six-digit code is on its way to
it,"_ and that conditional survives into all seven translations deliberately.

So the endpoint must not distinguish a registered from an unregistered address by:

- **status code** — `200` for both, never `404`;
- **body** — the same three fields with the same values;
- **timing** — enqueue the email, do not await delivery, and keep the unknown-address path doing
  comparable work rather than returning instantly;
- **anything downstream** — `POST /auth/verify-otp` for an unknown address answers `invalid_otp`,
  exactly like a wrong code, and never `account_not_found`.

The client folds an `account_not_found` on these two endpoints into a success and a wrong-code
respectively, so a server that leaks will not leak _through the UI wording_ — but it will still leak
through status codes and response times to anyone with `curl`. The defence has to be on your side.

---

## 6b. RevenueCat webhooks — what the backend must build

Added after the client's purchase flow landed. The client talks to RevenueCat directly and writes
its entitlement to local storage; **nothing in this section is on the client's critical path**, and a
webhook endpoint that is down cannot stop a pilgrim buying, restoring or using the app. Build it for
the server's own records, for support, and for refunds.

### The one thing this changes about §1

Purchase remains one of the four network actions, and it still does **not** touch this API — it goes
to StoreKit / Play Billing through RevenueCat. What is new is a **server-to-server** callback from
RevenueCat to you. The client never calls it, never waits on it, and never learns whether it
succeeded.

### `POST /webhooks/revenuecat`

**Auth.** RevenueCat sends a fixed `Authorization` header, set in the RevenueCat dashboard
(Project → Integrations → Webhooks). Compare it in constant time against a value from your
environment; reject anything else with `401`. There is no signature scheme — the shared secret in
that header is the whole of it, so it must be long, random, and never logged.

**Request.** `Content-Type: application/json`, with the event on the root under `event`:

```jsonc
{
  "api_version": "1.0",
  "event": {
    "id": "UUID", // idempotency key — see below
    "type": "INITIAL_PURCHASE", // see the table
    "app_user_id": "3f9a…", // OUR user.id — the value the client passed to logIn
    "original_app_user_id": "3f9a…",
    "product_id": "hajjcare.pass.lifetime",
    "entitlement_ids": ["hajjcare_pass"],
    "period_type": "NORMAL",
    "purchased_at_ms": 1793491200000,
    "expiration_at_ms": null, // ALWAYS null for this product — it is a lifetime pass
    "store": "APP_STORE", // or PLAY_STORE
    "environment": "PRODUCTION", // or SANDBOX — never grant on SANDBOX in production
    "price": 14.99,
    "currency": "USD",
    "transaction_id": "2000000123456789",
    "is_family_share": false,
  },
}
```

**Response.** `200` with any body as soon as the event is durably stored. RevenueCat retries on any
non-2xx with backoff for up to ~72 hours, so a slow or failing endpoint turns into duplicate
deliveries rather than lost ones — which is why the idempotency rule below is not optional.

**Event types to handle:**

| `type`                                                  | Meaning                                              | What the server should do                                                  |
| ------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `INITIAL_PURCHASE`                                      | The pass was bought                                  | Record the entitlement against `app_user_id`                               |
| `NON_RENEWING_PURCHASE`                                 | Also emitted for non-consumables on some store paths | Same as above — treat identically                                          |
| `TRANSFER`                                              | The purchase moved to a different `app_user_id`      | Move the entitlement; read `transferred_from` / `transferred_to`           |
| `CANCELLATION` with `cancel_reason: "CUSTOMER_SUPPORT"` | **A refund**                                         | Mark the entitlement revoked. This is the only event that withdraws access |
| `EXPIRATION`                                            | Should never arrive for this product                 | Log it loudly and do **not** act on it — see below                         |
| `SUBSCRIPTION_*`, `BILLING_ISSUE`, `PRODUCT_CHANGE`     | Subscription lifecycle                               | Ignore. The pass is not a subscription                                     |

**Rules:**

1. **Idempotency is required, not advisory.** Store `event.id` with a unique constraint and drop a
   duplicate before doing any work. Retries are normal operation, and a second `INITIAL_PURCHASE`
   must not become a second entitlement row.
2. **`app_user_id` is our own `user.id`** — the value the client passes to `Purchases.logIn`, the
   same id `GET /auth/me` returns and the same one that keys the pilgrim's local data. It is never
   an anonymous RevenueCat id. If one ever arrives looking like `$RCAnonymousID:…`, that is a client
   bug worth alerting on rather than a user to create.
3. **`expiration_at_ms` is always null and must stay unused.** The pass is a non-consumable lifetime
   purchase — see CLAUDE.md § Product. Do not write an expiry column, do not compute one, and do not
   build a job that sweeps expired entitlements. An `EXPIRATION` event for this product means either
   a misconfigured dashboard or a subscription product that should not exist; log it, alert, and
   change nothing.
4. **Only a refund revokes.** `CANCELLATION` with a customer-support reason is the single event that
   may withdraw a pass. Nothing else — not a failed webhook, not a missing event, not a reconciliation
   job that could not reach RevenueCat.
5. **Never trust `environment: "SANDBOX"` in production.** Store it, ignore it for entitlement.
6. **Answer fast.** Persist the raw event and return `200`; do the work on a queue. The endpoint's
   job is to accept, not to process.

### What the client does with any of this today: nothing

There is no endpoint for the client to read entitlement from, and there must not be one without the
conversation in §8. The pilgrim's access is decided from their own device's database; the server's
copy exists so that support can answer "did this person pay", and so a refund has somewhere to land.
If we later want a refund to reach the handset, that is a **new** design — the client currently has
exactly one revocation path and it comes from RevenueCat's own SDK, not from this API.

---

## 7. Non-negotiables

1. **camelCase JSON keys, request and response, everywhere.** No mixing. `refreshToken`, not
   `refresh_token`; `expiresInSeconds`, not `expires_in_seconds`.
2. **Response bodies are bare JSON objects at the top level.** No `{"data": ...}` envelope, no
   `{"success": true, "result": ...}` wrapper.
3. **Errors carry stable machine `code` strings, and the client's logic reads only those.** Message
   text is for your logs; every user-facing word comes from the app's translation files, in seven
   languages. Renaming a code changes app behaviour in a way no message change ever will.
4. **A `401` from `/auth/refresh` with a JSON body is the only response in this API that logs a
   pilgrim out.** Do not send it for anything transient.
5. **Never `404` or `409` under `/auth`** except for the two meanings in §3.2.
6. **`user.id` is stable forever.** It keys the pilgrim's local health data.
7. **No breaking changes to any shape, key, status or code in this document without telling me
   first.** Adding a new field or a new error code is safe and needs no coordination. Renaming,
   removing, changing a type, or changing which status carries which meaning requires a client
   release, and clients in the field during Hajj season may not be able to take one.

---

## 8. Open questions

Everything here is an **assumption I made writing this spec, not a requirement.** All of them are
reasonable to change — but each one has a matching change on the client, so **let's agree before
either side hardcodes it.**

**Format and transport**

1. **camelCase vs snake_case.** I assumed camelCase because the client's models were generated that
   way. Switching the whole API to snake_case is genuinely a one-line client change (a field-rename
   annotation on each DTO) — say the word before you build, not after.
2. **Path prefix.** I assumed the version segment lives in the base URL (`.../v1`) and your routes
   are exactly `/auth/*`. If you want `/api/v1/auth/*` that is fine and needs no client change, as
   long as the base URL carries the prefix.
3. **`201` vs `200` on register.** The client accepts any 2xx. Your call.

**Tokens**

4. **Access token 15 minutes.** Arbitrary — it is what the client's mock uses. Anything from 5
   minutes to a few hours works; the client only notices via 401s. Tell me what you pick.
5. **Refresh token 60 days, with rotation and a 60-second grace on the previous token.** The
   **45-day floor is firm**; everything else is negotiable. If you would rather not rotate at all,
   that is simpler and safe — just echo the token back.
6. **`expiresIn` in seconds, and sent on every token response.** The client tolerates its absence.
   Confirm you will send it, or say you won't.
7. **A "sign out all devices" action.** Not designed, not in the client. If you build per-device
   refresh tokens now it will be cheap later; if you build one shared token it will not be.
   `/auth/logout` today revokes one refresh token — confirm that is what you'll implement.

**Accounts**

8. **`user.id` is an opaque string** (UUID proposed). If yours is an integer, send it as a JSON
   string, not a number — the client's parser expects a string and will fail on a bare integer.
9. **`emailVerified` is returned but the app does nothing with it.** There is no email-verification
   flow in the client, and adding one would be a fifth network-required action, which is a product
   decision rather than an implementation one. Proposal: return `true` and leave the field as a
   placeholder. If you want real verification, raise it before building it.
10. **`fullName` optional on the server.** The UI always sends a trimmed name of at least 2
    characters, but the DTO permits null. Say if you want it required.
11. **Email case-insensitivity.** The client trims but does not lowercase. I assumed you normalise.
    Confirm — otherwise `Pilgrim@x.com` and `pilgrim@x.com` become two accounts.
12. **Password: min 8, no composition rules, no maximum.** The floor is firm (the client enforces
    it and a stricter server produces a worse error experience). A _maximum_ is the part worth
    discussing if your hashing has one.

**OTP and reset**

13. **600s expiry / 60s resend cooldown / 6 digits / 5 attempts.** All four are proposals except the
    digit count — `codeLength` other than 6 makes the translated copy wrong in seven languages, so
    changing it means a translation pass. The other three are just numbers; if your limiter wants
    900/30/3, say so and I'll match the countdowns.
14. **`attemptsRemaining` on a wrong code.** The client has a translated message ready — _"That code
    is not right. 2 tries left before you will need a new code."_ — but **nothing parses it from the
    wire today**. If you want it, send `attemptsRemaining` as an integer in the `invalid_otp` body
    and I'll wire the client up. It is a real usability win for elderly users; it is also a small
    enumeration signal. Your call, then mine.
15. **`Retry-After` on a `429`.** Same situation: modelled in the client, never parsed. Send it if
    it's easy and I'll wire it when we need it.
16. **Reset token lifetime 600s, single-use.** Single-use is firm. The duration is a proposal.
17. **What language the reset email is written in.** The app ships in seven languages and **sends no
    `Accept-Language` header today** — so right now you cannot know which one the pilgrim reads. If
    you want localised emails, the client needs to start sending the locale (either a header or a
    field on `/auth/forgot-password`). Worth deciding early; retrofitting it means a client release.

**Rate limiting**

18. **Brute-force protection on `/auth/login`.** Not designed. A `429` there currently renders as
    _"Too many tries. Wait a moment, then ask for a new code"_ — wording written for the OTP screen,
    nonsense on a sign-in form. If you want to rate-limit login, we need a distinct error code and a
    new translated message in all seven languages. Tell me before you turn one on.
19. **Rate limiting `/auth/forgot-password`.** `429` there is safe and the wording fits. Assume a
    per-address and per-IP limit is fine unless you hear otherwise.
20. **What `/auth/refresh` does under load.** Confirm it will answer `429` or `503` and never `401`,
    since only one of those three signs a pilgrim out.
