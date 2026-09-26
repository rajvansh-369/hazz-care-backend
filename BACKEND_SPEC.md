# HajjCare — Backend API Specification

**Audience:** the developer (and the AI assistant) building the Node.js service this Flutter client
talks to.

**Status:** derived from the client, and **re-verified against it on 24 September 2026** (previous
verification: 2 September 2026). Every path, JSON key, JSON type, status code, error code, OTP number
and user-facing message in §3–§6b was checked line by line against the files in the table below and
matches what the app actually serializes, sends, parses and switches on — not an idealised API. Where
the client would break on a wrong guess, that is called out inline. Where a value is a proposal
rather than a constraint, it is in **§8 Open questions**, which this revision did not change.

### What changed on 24 September 2026 — read this first

**Every change is tagged `[Δ 2026-09-24]` inline; search for `Δ` to find them all.** None of them
changes a path, a JSON key or a status code you have already built against. Several of them change
what the pilgrim sees when you return a status this document previously described as safe.

**The auth client's wire code has not changed since 2 September** — the models, the Dio setup, the
failure mapping and the mock are byte-identical. So most of the rows below are claims the 2 September
pass got wrong or left out, not new behaviour. The one real code change is in §6b.

| § | What this document said | What the client actually does | Kind |
|---|---|---|---|
| §3.2, §3.8 | `invalid_reset_token` shows *"That reset has expired, start again"* | Shows **"Your session has ended. Sign in again to continue."** — there is no reset-specific message | spec was wrong |
| §3.2 | A `401` anywhere except login/refresh → one silent refresh and retry | Only on `GET /auth/me`. On **register, forgot-password, verify-otp and reset-password** a `401` or `403` shows **"That email and password do not match."** | spec was wrong |
| §3 | "Six take no authentication" | **Seven** do; only `/auth/me` carries a bearer token | spec was wrong |
| §3.2 | Error body keys are optional | Optional — but `code` and each `message` **must be strings if present**. A number or object there turns the whole error into the generic "something went wrong" | newly documented |
| §2, §3.1 | JSON types implied | Stated per field. `emailVerified: 1` or `"true"` **fails a sign in**; numbers may be any JSON number, never a string | newly documented |
| §3.2, §3.6 | "Never 404 under /auth" | Still true, and sharper: a `404` on forgot-password is **shown as success** — the pilgrim is told a code is on its way when none was sent | newly documented |
| §3.3 | Only `/auth/login` must not `429` | A `429` on **register** shows the same OTP wording ("…then ask for a new code") on the sign-up form | newly documented |
| §3.5 | Refresh `user` "may be included" | It is **ignored**, but if present it must still parse as an `AuthUser` — a malformed one fails the whole refresh | newly documented |
| §3.5 | Background refresh "roughly every six hours" | On launch and on every resume, **at most once per six hours** since the last success *and* since the last attempt | clarified |
| §3.7 | `code` is "digits as typed" | Always **ASCII `0`–`9`**, exactly `codeLength` of them. The client strips anything else, including Arabic-Indic digits | newly documented |
| §3.9 | Body carries the refresh token | Can be **`{"refreshToken": ""}`** — a pilgrim who unticked *Keep me signed in* has no refresh token after a restart | newly documented |
| §5 | — | Resend is refused on the device until `resendAfterSeconds` has passed; verify is **not** refused on the device after `expiresInSeconds` — the server is asked | newly documented |
| §6b | `logIn` failure leaves the purchase anonymous | Still true, and **`configure` and `logIn` now give up after 15 seconds** (5 September), which widens that path. Signing out also calls `Purchases.logOut`, which moves the device to a fresh anonymous id | **code changed** |
| §6b | `hajjcare_pass` is pinned | Defaulted, and overridable per build with `--dart-define=HAJJCARE_ENTITLEMENT_ID` | newly documented |
| §6c | Links to "CLAUDE.md § Family" | That section moved to `docs/DECISIONS.md § Family` | link fixed |

Deliberately not pinned to a commit hash: a hash is stale the moment anything unrelated is
committed, and it was misleading here — an earlier revision of this line named a commit that
predated both this file and every line of purchase code in it. The durable check is that
`lib/features/auth/data/mock_auth_remote_data_source.dart` and the tests under `test/features/auth/`
are the executable version of this document. **If they and this file ever disagree, they are right.**

§6b (RevenueCat webhooks) was added after the client's purchase flow landed and describes a
server-to-server callback, not the auth API.

**Source of truth in the client, if you need to check something:**

| What | File |
|---|---|
| Request/response JSON shapes | `lib/features/auth/data/auth_api_models.dart` |
| Paths and the endpoint list | `lib/features/auth/data/auth_remote_data_source.dart` |
| Which client (public/authenticated) sends what | `lib/features/auth/data/auth_remote_data_source_impl.dart` |
| Status → failure classification | `lib/core/services/network/api_failure_mapper.dart` |
| Error-code → failure case | `lib/features/auth/domain/auth_failure.dart` |
| Failure case → the words on screen **[Δ 2026-09-24]** | `lib/features/auth/presentation/auth_failure_message.dart`, wording in `lib/l10n/app_en.arb` |
| Headers, timeouts wired into Dio **[Δ 2026-09-24]** | `lib/core/services/network/api_client.dart` |
| Timeouts, base URL | `lib/core/services/network/api_config.dart` |
| Reference implementation of every rule below | `lib/features/auth/data/mock_auth_remote_data_source.dart` |
| Store identity and the entitlement id (§6b) **[Δ 2026-09-24]** | `lib/features/subscription/data/revenuecat_purchase_service.dart`, `purchase_config.dart` |

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
client — *nothing happened* — and there is exactly one exception, documented in §4. Design your
error handling knowing the client will not log anybody out for you, and must not be relied on to.

---

## 2. Stack expectations

The client is agnostic to how you build this: Express, Fastify, NestJS, Postgres, Prisma, whatever
you prefer. Nothing in the app knows or cares. What the client's behaviour *does* pin down:

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
- **[Δ 2026-09-24] JSON types are checked, and a wrong type fails the whole response.** A string
  field must be a JSON string; a boolean must be `true`/`false`, never `1` or `"true"`; a number may
  be any JSON number (a fraction is truncated) but never a string such as `"900"`. `null` or an
  absent key is fine wherever this document says *optional*. **Unknown extra keys are ignored**, so
  adding a field is always safe. A body that fails these checks surfaces as *"Something went wrong
  on our side. Please try again in a moment."* and nothing is stored.
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
`https://api.hajjcare.example/v1/auth/login`. A trailing slash on the base URL is harmless; the
client collapses the doubled `/`.

**[Δ 2026-09-24]** A build with no base URL runs against the built-in mock and never touches the
network. Supplying a base URL switches to the real client automatically. The mock can also be
forced on or off with `--dart-define=HAJJCARE_USE_MOCK_BACKEND=true|false`, which is the switch to
check first if the app appears not to be calling your server.

---

## 3. Endpoints

Eight endpoints, all under `/auth`. **[Δ 2026-09-24] Seven** take no authentication at all (this
said six); only `GET /auth/me` carries a bearer token. The seven go out on a client with no
interceptors, so **nothing refreshes or retries them** — see the 401 row in §3.2.

| Method | Path | Auth header | Purpose |
|---|---|---|---|
| POST | `/auth/register` | no | Create account, return a session |
| POST | `/auth/login` | no | Return a session |
| POST | `/auth/refresh` | no | Exchange a refresh token for a new pair |
| POST | `/auth/forgot-password` | no | Email a one-time code |
| POST | `/auth/verify-otp` | no | Exchange a code for a reset token |
| POST | `/auth/reset-password` | no | Set a new password with a reset token |
| POST | `/auth/logout` | no | Invalidate a refresh token |
| GET | `/auth/me` | **yes** | Current account |

`/auth/refresh` and `/auth/logout` deliberately carry **no** `Authorization` header: the refresh
token in the body is what identifies the session, and routing them through the authenticated client
would make a failing refresh trigger a refresh.

### 3.1 Shared response objects

Three objects recur. Their keys are fixed by the client's parser.

```jsonc
// AuthTokens
{
  "accessToken":  "string",   // required
  "refreshToken": "string",   // required — see §4, required even when you do not rotate
  "expiresIn":    900          // optional, integer SECONDS, access-token lifetime
}
```

```jsonc
// AuthUser
{
  "id":            "string",  // required, stable, non-empty — see the warning below
  "email":         "string",  // required
  "fullName":      "string",  // optional, may be null
  "emailVerified": true        // optional, defaults to false when absent — a JSON boolean ONLY
}
```

**[Δ 2026-09-24]** Types, exactly as the parser checks them: `accessToken`, `refreshToken`, `id`,
`email` are JSON strings and must be present and non-null; `fullName` is a string or null;
`expiresIn` is any JSON number or null; `emailVerified` is `true`, `false`, null or absent.
**`"emailVerified": 1` or `"emailVerified": "true"` fails the parse and the pilgrim cannot sign in**
— they see the generic server-error message. An `id` that is empty or only whitespace is also
refused (§7.7).

```jsonc
// AuthSession — the body of login, register and refresh
{
  "tokens": { /* AuthTokens */ },   // required
  "user":   { /* AuthUser   */ }    // required on login and register; optional on refresh
}
```

> **`user.id` is the Drift primary key for everything the pilgrim owns.** It must be stable for the
> life of the account and identical across login, register, refresh and `/auth/me`. If it ever
> changes for an existing account, that pilgrim's local health passport and medication schedule
> stop being associated with them. Never reuse an id across accounts.

> **`user` is required on login and register.** The client throws a parse error (surfaced as a
> server failure, no session created) if a login or register response has no `user`. On `/auth/refresh`
> it is optional and normally omitted — the session being renewed already knows whose it is.
>
> **[Δ 2026-09-24] On `/auth/refresh` a `user` is ignored, but it is still parsed.** The client never
> adopts an identity from a refresh. It does, however, read the whole body before discarding `user`,
> so a `user` with a wrong type in it (an integer `id`, a missing `email`) fails the refresh. That
> costs no session immediately, but every refresh fails the same way, so after 45 days the pilgrim is
> asked to sign in again. Omit `user` on refresh, or send a well-formed one.

### 3.2 Error responses — the shape and the codes

Every non-2xx response should carry a JSON object of this shape. Both keys are optional; `errors`
may also be spelled `fieldErrors`.

```jsonc
{
  "code": "email_taken",                 // top-level machine code — a string, or absent
  "errors": [                            // per-field codes
    { "field": "email", "code": "email_taken", "message": "for your logs only" }
  ]
}
```

**[Δ 2026-09-24] Types in the error body.** An `errors` entry is used only if both `field` and `code`
are strings; any other entry is skipped, harmlessly. But **the top-level `code`, and `message` on any
entry, must be a string or absent.** A number or object in either place makes the client's error
parser throw, and the whole response is then reported as *"Something went wrong on our side"* — the
field routing and every specific message in the table below are lost. (Not applied on `401`/`403`,
whose bodies are not read.)

**How the client classifies a response, before it looks at any code:**

| Status | Client's classification | Effect |
|---|---|---|
| 2xx | success | body parsed |
| **401** | unauthorized | **[Δ 2026-09-24]** on `/auth/refresh` → **session revoked if the answer is JSON, see §4**; on `/auth/me` → one silent refresh + retry; on `/auth/logout` → ignored; on **every other endpoint — login, register, forgot-password, verify-otp, reset-password** → *"That email and password do not match."* |
| **403** | unauthorized | same as 401 except that **it never triggers a refresh**: on `/auth/me` the request just fails |
| other 4xx | validation failure | `code`/`errors` are read, see the table below |
| 5xx, other non-2xx, or an unparseable 2xx body | server failure | *"Something went wrong on our side. Please try again in a moment."*, with a Try again button; session untouched |
| no response at all (timeout, DNS, dropped socket, TLS failure) | offline | *"…needs a connection…"*, in a neutral grey rather than red; **nothing changes**, no sign-out, no redirect |

Note that **`code` is ignored on 401 and 403** — those are classified by status alone. Send one
anyway for your logs, but do not rely on the client reading it.

> **Return `401`, never `403`, for an expired access token.** This is not a preference. The client's
> refresh-and-retry is wired to `401` only — `RefreshInterceptor._shouldAttemptRefresh` tests
> `statusCode == 401` and deliberately excludes `403`, on the reasoning that 403 means *"we know who
> you are and you still may not do this"*, which a fresh token would not fix. So a server that
> answers `403` for an expired token gets no refresh and no retry: every such request simply fails,
> and the pilgrim sees errors on a screen that would have worked. Reserve `403` for genuine
> authorization refusals that a new token would not change.
>
> The asymmetry is worth reading twice, because it is the one place 401 and 403 are *not*
> interchangeable in opposite directions: **on `/auth/refresh` both statuses can end a session**
> (§4), while **elsewhere only `401` is recoverable**.

**Codes the client understands**, in the order it tests them. The order matters: the first match
wins, so a 429 that also carries `"code": "invalid_otp"` is treated as a lockout, not a wrong code.

**[Δ 2026-09-24]** The *Client shows* column is now the app's exact English wording, where it used to
be a paraphrase. Every message is translated into all seven languages from the app's own files; none
is ever taken from your response.

| # | Condition | Client shows (English) |
|---|---|---|
| 1 | status `409`, or `code: "email_taken"`, or field `email` = `email_taken` | "That email address already has an account. Try signing in instead." |
| 2 | `code: "invalid_credentials"` | "That email and password do not match. Check both and try again." |
| 3 | status `404`, or `code: "account_not_found"`, or field `email` = `account_not_found` | "We could not find an account for that email address." — **except** on forgot-password (shown as success) and verify-otp (shown as a wrong code), §6 |
| 4 | `code: "invalid_reset_token"`, or field `token`/`resetToken` = `invalid_reset_token` | **[Δ 2026-09-24]** "Your session has ended. Sign in again to continue." — this said *"That reset has expired, start again"*, which the client has never shown. It reuses the session-revoked message; there is no reset-specific one |
| 5 | status `429`, or `code: "too_many_attempts"` | "Too many tries. Wait a moment, then ask for a new code." — **on every endpoint, including register and login** |
| 6 | `code: "otp_expired"`, or field `code` = `otp_expired` | "That code has expired. Ask for a new one and we will send it straight away." (amber, not red) |
| 7 | `code: "invalid_otp"`, or field `code` = `invalid_otp` | "That code is not right. Check the digits and try again." |
| 8 | anything else 4xx | field codes the form knows are shown under the field; anything else → "Check the details above and try again." |

Row 8 in detail **[Δ 2026-09-24]**:

- **Register:** field `password` = `password_too_short` → under the password field. **Any** code on
  field `email` (other than `email_taken`, which row 1 caught) → under the email field, as *invalid
  email*. Any other field or code → the banner.
- **Reset password:** only field `password` = `password_too_short` is routed; everything else → the
  banner.
- **Sign in, forgot-password, verify-otp:** no field routing; always the banner.

A `4xx` whose body is empty or not JSON is still classified by status alone — `404`, `409` and `429`
still take rows 3, 1 and 5.

> **Two traps that follow from rows 1 and 3, and they are the ones most likely to bite you:**
>
> - **Never return a bare `404` from anything under `/auth`, including for an unknown route or a
>   typo'd path.** Any 404 is rendered to the pilgrim as *"We could not find an account for that
>   email address."* A missing route would tell a pilgrim their account does not exist.
>   **[Δ 2026-09-24] On `/auth/forgot-password` it is worse:** the client turns a `404` into a
>   *success*, so a missing or misrouted endpoint tells the pilgrim a code is on its way when nothing
>   was sent, and they wait for an email that will never arrive.
> - **Never return `409` from an `/auth` endpoint for anything except a duplicate registration.** Any
>   409 is rendered as *"That email address already has an account."*
> - **[Δ 2026-09-24] Never return `401` or `403` from register, forgot-password, verify-otp or
>   reset-password** — not from auth middleware applied to the whole router, not for a missing API
>   key. On all four the pilgrim is told *"That email and password do not match"*, on screens where
>   they did not type a password or typed a new one.
>
> For rate limiting, maintenance and infrastructure errors use `429` and `503`. Both are safe:
> neither clears a session. (`429` has wording of its own, row 5 — see §3.3 and §3.4 for where it
> reads badly.)

Unknown codes are safe — the client degrades to a generic message rather than crashing, so you can
add codes without a client release. Changing or removing an existing one is a breaking change (§7).

---

### 3.3 `POST /auth/register`

**Request**

```jsonc
{
  "email":    "string",  // required
  "password": "string",  // required
  "fullName": "string"   // key ALWAYS present; value may be null
}
```

| Field | Client already enforces | Server must match |
|---|---|---|
| `email` | non-empty, trimmed, matches `^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$` | may be stricter about deliverability, but a pilgrim who registered with an address must be able to sign in with it |
| `password` | **min 8 characters, any characters, no maximum** | **must not be stricter.** No composition rules, no truncation. See the note below |
| `fullName` | trimmed, min 2 characters, always sent non-null by the UI today | treat as optional; the DTO permits null |

> The 8-character, composition-free rule is a deliberate choice for elderly users typing on a phone
> keyboard, often in a second script, and it matches NIST SP 800-63B's floor. A server stricter than
> the client means the app lets a pilgrim submit a password the server then refuses — the rejection
> arrives as a server error instead of an inline rule they could have followed before typing it.
> There is no maximum: a passphrase is a good password and silently truncating one makes it a bad one.

**Success — `200` or `201`**

```json
{
  "tokens": { "accessToken": "eyJ...", "refreshToken": "def502...", "expiresIn": 900 },
  "user": { "id": "3f9a...", "email": "pilgrim@example.com", "fullName": "Aisha Rahman", "emailVerified": true }
}
```

`user` is **required** here.

**Errors**

| Case | Status | Body | Client shows |
|---|---|---|---|
| Address already registered | `409` | `{"code":"email_taken","errors":[{"field":"email","code":"email_taken"}]}` | banner: already has an account |
| Password below the minimum | `422` | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}` | inline, under the password field |
| Address rejected by the server | `422` | `{"code":"invalid_input","errors":[{"field":"email","code":"email_invalid"}]}` | inline, under the email field (any `email` code that is not `email_taken` lands here) |
| Server broke | `5xx` | any | retryable banner |

> **[Δ 2026-09-24] Do not `429` this endpoint either.** The client's rate-limit wording — *"Too many
> tries. Wait a moment, then ask for a new code."* — is shown on the sign-up form exactly as it is on
> sign in (§3.4), where there is no code to ask for. The same trade-off and the same client change
> as §8 item 18 apply.
>
> **[Δ 2026-09-24]** `fullName` is sent trimmed, at least 2 characters, on every registration the
> app makes today. The sign-up form also requires ticking a terms-and-conditions box, but **nothing
> about that consent is sent** — there is no terms field or terms version in the request.

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
{ "email": "string", "password": "string" }   // both required
```

`email` is trimmed by the client but **not lowercased** — match addresses case-insensitively on your
side. `password` is sent exactly as typed, never trimmed.

**Success — `200`**: identical shape to register. `user` is **required**.

**Errors**

| Case | Status | Body | Client shows |
|---|---|---|---|
| Wrong password, or unknown address | `401` | `{"code":"invalid_credentials"}` | "That email and password do not match. Check both and try again." |
| Server broke | `5xx` | any | retryable banner |

**[Δ 2026-09-24]** A `403` here reads identically to a `401`. The body of either is not read.

The sign-in form's *Keep me signed in* box (ticked by default) changes nothing on the wire. Unticked,
the refresh token is kept in memory only, so after the app restarts that device never calls
`/auth/refresh` again for this session, and its `/auth/logout` carries an empty token (§3.9).

> **Return `401` for an unknown address too, not `404`.** A `404` here is a working account-enumeration
> oracle: type an address, learn whether that person uses HajjCare. The client *can* render a distinct
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
{ "refreshToken": "string" }   // required
```

No `Authorization` header. Sent by two independent callers: a background refresher (unawaited,
nothing waits for it) and the 401 interceptor (single-flight — concurrent 401s share one refresh
call).

**[Δ 2026-09-24]** The background refresher runs at launch and on every return to the foreground,
and sends a request only if **six hours** have passed both since the last *successful* refresh and
since the last *attempt*. It never runs for a session with no stored refresh token (see §3.4). So
expect, per device, at most one background refresh every six hours, plus one per `401` burst on
`/auth/me`.

**Success — `200`**

```json
{ "tokens": { "accessToken": "eyJ...", "refreshToken": "def502...", "expiresIn": 900 } }
```

`user` may be included but is normally omitted; the client carries the existing identity forward.
**[Δ 2026-09-24]** An included `user` is ignored, but it must still be well formed — see §3.1.
**`tokens.refreshToken` is required even if you do not rotate** — omit it and the response fails to
parse. If you do not rotate, echo the same token back.

**Errors**

| Case | Status | Body | Client behaviour |
|---|---|---|---|
| **Refresh token genuinely revoked or expired** | `401` | **JSON object**, e.g. `{"code":"session_revoked"}`, with `Content-Type: application/json` | **Clears the session and signs the pilgrim out.** The only automatic sign-out in the whole app |
| `401` or `403` that is **not** JSON (no JSON content type, body not a JSON object) **[Δ 2026-09-24]** | `401`/`403` | e.g. an HTML page | treated as a server error; call fails, **session untouched** |
| Rate limited | `429` | `{"code":"too_many_attempts"}` | call fails, **session untouched** |
| Maintenance / server error | `5xx` | any | call fails, **session untouched** |
| Unreachable, timeout, captive portal | — | — | call fails, **session untouched** |

> **A `401` (or `403`) here is the one thing in this API that can end a pilgrim's session.**
> **`/auth/refresh` must never answer `401` for anything transient.** Not for rate limiting, not
> during a deploy, not while a dependency is down, not as a generic error handler's default. Return
> it only when the refresh token is genuinely dead — revoked, expired, or unknown. Everything else
> is `429` or `503`, both of which leave the session alone.
>
> **Do not rely on an empty body to make a `401` safe.** An earlier revision of this document
> claimed that a bare `401` with no JSON body would not sign anyone out. **That was wrong.** The
> client's check is `ApiFailureMapper.looksLikeApiJson`, and it returns true if the response's
> `Content-Type` header contains `application/json` **or** the body parsed as a JSON object — it
> does not require a body at all. So `res.status(401).type('json').end()`, and every framework
> default that stamps a JSON content type on an error response with nothing in it, **is treated as a
> genuine revocation and signs the pilgrim out.**
>
> What the check does buy is the case it was written for: a hotel or airport captive portal
> answering `401` with an HTML sign-in page is ignored, because being on bad wifi must not sign a
> pilgrim out. It is a defence against the network, not against this API.

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
{ "email": "string" }   // required, trimmed by the client
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

| Case | Status | Body | Client behaviour |
|---|---|---|---|
| Unknown address | **`200`** — see below | same as success | proceeds to the code screen, identically |
| Resend abuse | `429` | `{"code":"too_many_attempts"}` | "Too many tries. Wait a moment, then ask for a new code." |
| Server broke | `5xx` | any | retryable banner — the pilgrim is *not* sent to a code screen for a code that was never sent |
| **[Δ 2026-09-24]** Any `404`, or `code: "account_not_found"` | `404` | any | **shown as success** — the client folds it in to avoid leaking account existence, so a misrouted endpoint looks like a sent code (§3.2) |
| **[Δ 2026-09-24]** A `200` whose body fails to parse (e.g. `"codeLength": "6"`) | `200` | — | retryable banner, and the pilgrim is *not* sent to the code screen — although your email has already gone out |

**[Δ 2026-09-24]** This endpoint is called again, unchanged, by the code screen's **Resend** button.
The device refuses the tap until `resendAfterSeconds` has passed, so a resend request arriving
sooner than that did not come from an untampered client.

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
  "email": "string",   // required — six digits identify nobody; verify the pair
  "code":  "string"    // required — ASCII digits 0-9 only, exactly codeLength of them (e.g. "123456")
}
```

Client-side the code must be non-empty and exactly `codeLength` characters before a request is made.

**[Δ 2026-09-24]** The code boxes accept ASCII `0`–`9` and nothing else: any other character is
dropped as it is typed, **including Arabic-Indic digits (`٠`–`٩`)**. So `code` on the wire is always
ASCII digits and needs no normalising on your side. `email` is the address from the forgot-password
step, trimmed and not lowercased, as on every other endpoint.

**[Δ 2026-09-24]** The device does **not** refuse to submit once its own countdown reaches zero — it
shows *"This code has expired. Ask for a new one."* but still sends the request if the pilgrim taps
Verify. Your `otp_expired` is what actually decides.

**Success — `200`**

```json
{ "resetToken": "rst_9f3c...", "expiresInSeconds": 600 }
```

**A reset token and nothing else. Never an access token, never a refresh token, never a session** —
the client's response type has no field to put one in, and a verified code is not a login. See §6.

**Errors** — checked in this order, which matters:

| Case | Status | Body | Client shows |
|---|---|---|---|
| Locked out (too many wrong codes) | `429` | `{"code":"too_many_attempts"}` | "Too many tries. Wait a moment, then ask for a new code." |
| Code expired | `400` | `{"code":"otp_expired","errors":[{"field":"code","code":"otp_expired"}]}` | "That code has expired. Ask for a new one and we will send it straight away." |
| Wrong code | `400` | `{"code":"invalid_otp","errors":[{"field":"code","code":"invalid_otp"}]}` | "That code is not right. Check the digits and try again." |
| Unknown address | `400` | `{"code":"invalid_otp"}` | same as a wrong code — **never `404`** (a `404` is folded into a wrong code by the client, but it still leaks by status) |

The digits the pilgrim typed are **kept** after any of these; they correct one digit rather than
retyping six.

> **Check the lockout before the code**, so a locked-out pilgrim typing the *right* code is still
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
  "resetToken": "string",  // required — the token from verify-otp, not a session token
  "password":   "string"   // required, min 8 chars, same rule as registration
}
```

**Success — `204`** (or any 2xx). **The response body is not read.** Do not return tokens here: the
pilgrim is sent to the sign-in screen to type the password they just chose, which is what proves
they know it.

**Errors**

| Case | Status | Body | Client shows |
|---|---|---|---|
| Token invalid, expired, or already used | `400` | `{"code":"invalid_reset_token","errors":[{"field":"resetToken","code":"invalid_reset_token"}]}` | **[Δ 2026-09-24]** "Your session has ended. Sign in again to continue." (this said *"That reset has expired, start again"*; see §3.2 row 4) |
| Password below the minimum | `422` | `{"code":"invalid_input","errors":[{"field":"password","code":"password_too_short"}]}` | inline, under the password field |

**[Δ 2026-09-24]** The client does not check the reset token's `expiresInSeconds` itself; it always
sends the request and lets you decide. On success it moves to a confirmation screen whose only
action goes to sign in. It sends the password exactly as typed — never trimmed — and only after the
pilgrim has typed it twice and both copies match.

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
{ "refreshToken": "string" }   // required
```

No `Authorization` header. **Success — `204`** (or any 2xx); the body is not read.

**The client has already cleared its local session before this call is made**, and the result is
only logged. A pilgrim who taps Sign Out in Arafat with no signal is signed out locally regardless.

Consequences for you: this endpoint is **best-effort and must be idempotent**. An unknown, already-
revoked or already-expired refresh token should return `204`, not an error — there is nothing the
client can do with the failure, and nothing it will do.

**[Δ 2026-09-24] Expect `{"refreshToken": ""}`.** A pilgrim who signed in with *Keep me signed in*
unticked, and has restarted the app since, has no refresh token on the device, and signing out still
sends this call with an empty string. Answer it with `204` like any other unknown token — do not
`400` or `422` it. That session's refresh token stays valid on your side until it expires on its own.

**[Δ 2026-09-24]** Sign out now exists in the app: Profile → Sign out, behind a confirmation. It
clears the session only — health data stays on the device. It also releases the store identity
(`Purchases.logOut`), which matters for §6b.

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
{ "id": "3f9a...", "email": "pilgrim@example.com", "fullName": "Aisha Rahman", "emailVerified": true }
```

A bare `AuthUser` — **not** wrapped in `{"user": ...}`.

**Errors**

| Case | Status | Client behaviour |
|---|---|---|
| Access token expired | `401` | the interceptor refreshes **once** and retries the request automatically. A second `401` fails the call — and **does not sign anyone out** |
| Forbidden | `403` | fails immediately, no refresh attempted (a new token would not help) |
| Server broke | `5xx` | fails, retryable |

> Implemented in the client but **not called by any screen today** (re-checked 24 September). Build
> it — it costs little and the profile feature will want it — but nothing is currently blocked on it.
> The same type rules as §3.1 apply, including the refusal of a blank `id`.

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
  silent refresh and one retry. If that fails, the *request* fails. The session stays.
- **A timeout, a DNS failure, a dropped socket, a captive portal, a `5xx`: nothing happens.** The
  session stays, the pilgrim stays where they are, and no login screen appears.
- **Do not build any flow that assumes the client will log out when you reject it.** If you need a
  session gone, revoke the refresh token and wait for the next refresh (§ below). If you need it
  gone *now*, that is a feature that does not exist yet and needs designing — it cannot be bolted on
  by returning 401s.

This is not a preference. A pilgrim locked out of the app in Mina has lost their medication alarms
and their emergency button, days from a working data connection, and cannot recover without one.

### Token lifetimes the client assumes

| | Value | How firm |
|---|---|---|
| Access token | **15 minutes** (`expiresIn: 900`) | proposal — the client works with any value, see §8 |
| Refresh token | **at least 45 days**, 60 proposed | **firm floor.** Shorter than 45 days and a pilgrim offline for a full Hajj comes home to a dead session |
| Reset token (from verify-otp) | **10 minutes** | proposal, must be minutes not hours |
| OTP code | **10 minutes** | see §5 |

**[Δ 2026-09-26] What the server implements.** The refresh token lifetime is **60 days by default
and sliding**: every successful refresh issues a token that lives a full 60 days from that moment,
matching the client's own "every successful refresh resets the 45 days". It is configurable from
**45 to 365 days**, and the server refuses to start with a value outside that range, so the 45-day
floor cannot be broken by a configuration mistake.

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

**[Δ 2026-09-26] What the server implements: rotation invalidated by use, not by time.** The
server rotates on every refresh, but there is no grace window. The previous refresh token keeps
returning a fresh pair, with no time limit, until one of the tokens it returned has itself been
used; only then does it answer `401`. Both uncoordinated callers get `200`, and a refresh response
lost in transit costs nothing: the retry, however many hours later, still works. A time-bounded
window could not survive that: the background refresher's next attempt comes six hours later, long
after 60 seconds. Logout ends every token issued from that sign-in. Nothing on the wire changed:
same request, same response, same status codes. The client relies only on what it already does —
it never keys on the refresh token value, and only a `401`/`403` from `/auth/refresh` signs anyone
out.

### The one condition that may end a session

> **`POST /auth/refresh` answering `401` or `403` with a `Content-Type: application/json` header, or
> with a body that parsed as a JSON object.**

That is the complete list. The client requires both the status *and* a sign that the answer was this
API's own, because a hotel or airport captive portal answers `401` with an HTML sign-in page and
believing it would sign a pilgrim out for connecting to the wifi.

**Read that condition literally: the JSON header alone is enough, with no body.** It is not a second
safety net you can lean on — see the note in §3.5. If you would not want a pilgrim signed out by a
response, do not give that response a 401 or a 403 on this endpoint.

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

| Rule | Value | Where it shows in the UI |
|---|---|---|
| Code length | **6 digits** | six input boxes, sized from `codeLength` |
| Code lifetime | **600s (10 min)** | "This code expires in 9:58." — ticks every second |
| Resend cooldown | **60s** | "Resend code in 0:47" — the button stays tappable and states the wait |
| Max wrong attempts | **5**, then lock | "Too many tries. Wait a moment, then ask for a new code." |

Additional behaviour the client depends on:

- **`codeLength` must be 6.** The screen sizes its boxes from your value, but the app's translated
  copy in all seven languages says "a six-digit code" in prose. Sending 4 or 8 makes the text lie in
  every locale.
- **A resend voids the previous code and resets the attempt counter to zero.** The client's Resend
  button exists to rescue a locked-out pilgrim; if a lockout survives a new code, the button does
  nothing for the person who needs it most. (A separate, slower limit on *resends themselves* is
  fine and expected — answer those with `429`.)
- **Check the lockout before checking the code** (§3.7).
- **An expired code does not consume an attempt** (§3.7).
- **Five, not three.** These pilgrims are reading six digits off a phone screen in bright sun. A
  limiter that locks on the second slip is a support call, not a security control.
- **Send the durations on every response, including resends** — a resend returns a full fresh
  600/60, not the remainder of the old window.

The client has a message ready for "N tries left before you need a new code" but **does not parse an
attempts counter from the wire today** — see §8 if you want to send one.

**[Δ 2026-09-24] Which of these the device enforces itself, and which it leaves to you:**

| Rule | On the device | On your side |
|---|---|---|
| Code length | Boxes sized from `codeLength`; Verify refuses fewer digits | Checks the digits |
| Resend cooldown | Resend is refused until `resendAfterSeconds` has passed, and says how long is left | Your own, slower resend limit |
| Code lifetime | Countdown only; switches to *"This code has expired. Ask for a new one."* at zero, **but still submits** | `otp_expired` is the decision |
| Max attempts | **Not counted on the device at all** | Entirely yours |
| Reset token lifetime | Not checked | Entirely yours |

The countdowns run on the device's own clock from the moment the response arrives, ticking once a
second while the screen is open.

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
copy is worded *"If pilgrim@example.com has a Hajj Care account, a six-digit code is on its way to
it,"* and that conditional survives into all seven translations deliberately.

So the endpoint must not distinguish a registered from an unregistered address by:

- **status code** — `200` for both, never `404`;
- **body** — the same three fields with the same values;
- **timing** — enqueue the email, do not await delivery, and keep the unknown-address path doing
  comparable work rather than returning instantly;
- **anything downstream** — `POST /auth/verify-otp` for an unknown address answers `invalid_otp`,
  exactly like a wrong code, and never `account_not_found`.

The client folds an `account_not_found` on these two endpoints into a success and a wrong-code
respectively, so a server that leaks will not leak *through the UI wording* — but it will still leak
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

**Auth. Two mechanisms, and you should use the second.** Both are configured on the webhook
integration in the RevenueCat dashboard (Project → Integrations → Webhooks).

1. **A fixed `Authorization` header.** A shared secret RevenueCat sends on every request. Compare it
   in constant time against a value from your environment and reject anything else with `401`. Long,
   random, never logged.
2. **HMAC-SHA256 signing — prefer this.** Enable *HMAC webhook signing* and RevenueCat adds
   `X-RevenueCat-Webhook-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>`, where the HMAC is
   computed over the string `"<timestamp>.<raw_json_body>"` using the integration's signing secret.
   To verify: parse `t` and `v1`, recompute over `"{t}.{raw body}"`, compare in constant time, and
   reject requests whose timestamp is outside a tolerance you choose (five minutes is reasonable) so
   a captured request cannot be replayed.

   **Compute the HMAC over the raw request body bytes, exactly as received, before any JSON
   parsing.** Re-serializing a parsed object changes the bytes and makes every valid request fail
   verification. In Express that means capturing the raw body for this route specifically, not
   relying on `express.json()`.

   The signing secret is **shown once**, at creation or rotation, and cannot be retrieved
   afterwards. Store it before you close the dialog; the only recovery is Rotate, which invalidates
   the old one immediately.

**Request.** `Content-Type: application/json`, with the event on the root under `event`:

```jsonc
{
  "api_version": "1.0",
  "event": {
    "id": "UUID",                       // idempotency key — see below
    "type": "NON_RENEWING_PURCHASE",    // see the table
    "app_user_id": "3f9a…",             // OUR user.id — usually; see rule 2
    "original_app_user_id": "…",        // the FIRST id ever seen for this customer
    "aliases": ["3f9a…", "$RCAnonymousID:…"],  // every id known for this customer
    "product_id": "…",                  // do NOT hardcode — see rule 3
    "entitlement_ids": ["hajjcare_pass"],
    "period_type": "NORMAL",
    "purchased_at_ms": 1793491200000,
    "expiration_at_ms": null,           // ALWAYS null for this product — it is a lifetime pass
    "store": "APP_STORE",               // or PLAY_STORE
    "environment": "PRODUCTION",        // or SANDBOX — never grant on SANDBOX in production
    "price": 14.99,
    "currency": "USD",
    "transaction_id": "2000000123456789",
    "is_family_share": false
  }
}
```

**Response.** Return **`200`** — specifically 200, not any 2xx — as soon as the event is durably
stored, and within **60 seconds**. RevenueCat retries a failed delivery **up to 5 times with
increasing delays of 5, 10, 20, 40 and 80 minutes**, recomputing the timestamp and signature on each
attempt. (An earlier revision of this section said retries continue for ~72 hours. They do not; the
whole retry window is under three hours, which makes durable storage on first delivery more
important, not less.)

**Event types to handle:**

| `type` | Meaning | What the server should do |
|---|---|---|
| `NON_RENEWING_PURCHASE` | **The pass was bought.** This is the event for our product | Record the entitlement against the resolved user — see rule 2 |
| `INITIAL_PURCHASE` | A *subscription* was started | Should not arrive for this product. Handle it identically if it does, and log it |
| `TRANSFER` | Transactions and entitlements moved between two customers, typically via Restore Purchases | Move the entitlement. `transferred_from` and `transferred_to` are **arrays of App User ID strings**, not scalars. The webhook is sent only for the destination customer |
| `CANCELLATION` with `cancel_reason: "CUSTOMER_SUPPORT"` | **A refund.** The only event that withdraws access | Mark the entitlement revoked |
| `CANCELLATION` with any other `cancel_reason` | Subscription lifecycle | **Ignore.** See rule 4 |
| `REFUND_REVERSED` | A refund was reversed — the money came back to us. App Store only | **Re-grant** the entitlement. The mirror of the refund case, and the only other event that changes access |
| `TEST` | The dashboard's *Send test webhook* button | Return `200` and store nothing. See rule 7 |
| `EXPIRATION` | Should never arrive for this product | Log it loudly and do **not** act on it — see rule 5 |
| `TEMPORARY_ENTITLEMENT_GRANT` | RevenueCat granted access during an outage of its own | Log. Do not treat as a purchase — no money moved |
| `SUBSCRIPTION_*`, `BILLING_ISSUE`, `PRODUCT_CHANGE`, `UNCANCELLATION`, `INVOICE_ISSUANCE`, `PRICE_INCREASE_*`, `VIRTUAL_CURRENCY_TRANSACTION`, `EXPERIMENT_ENROLLMENT`, `PURCHASE_REDEEMED` | Subscription and billing lifecycle | Ignore. The pass is not a subscription |

RevenueCat adds event types over time. **Treat an unrecognised `type` as "store it and return 200",
never as an error** — a 500 on an unknown type turns a new RevenueCat feature into five retries and
a page. Check their event reference when you build, since the list above is a snapshot.

**Rules:**

1. **Idempotency is required, not advisory.** Store `event.id` with a unique constraint and drop a
   duplicate before doing any work. Retries are normal operation, and a second purchase event must
   not become a second entitlement row.

2. **`app_user_id` is usually our own `user.id` — and you must handle the case where it is not.**

   The client calls `Purchases.logIn(session.userId)` with the same id `GET /auth/me` returns and
   the same one that keys the pilgrim's local data, so the common case is exactly what you expect.

   **But a purchase under an anonymous id is reachable in normal operation, and is not a client
   bug.** `RevenueCatPurchaseService.start` deliberately swallows a failed `logIn` — it is awaited
   by the paywall after the button is already spinning, and an exception there would leave a pilgrim
   staring at a spinner with nothing on screen to explain it. So a pilgrim whose signal drops at the
   moment they tap Unlock can complete a **real, paid** purchase while the SDK is still on the
   anonymous id RevenueCat mints per install, and the webhook arrives with
   `app_user_id: "$RCAnonymousID:…"`.

   **[Δ 2026-09-24] This path is now wider than it was on 2 September.** Since 5 September the client
   gives up on `Purchases.configure` and `Purchases.logIn` after **15 seconds** and carries on, so on
   a slow connection — not only a dropped one — the paywall can proceed while the SDK is still
   anonymous. (The same 15-second limit covers loading the offer and Restore; it deliberately does
   **not** cover the payment sheet itself, which can wait hours for Ask to Buy.)

   **[Δ 2026-09-24] Signing out also produces an anonymous id.** When a session ends — sign out, or
   the revocation in §4 — the client calls `Purchases.logOut`, and RevenueCat moves the device to a
   fresh anonymous id until the next pilgrim's `logIn` succeeds. On a shared family handset that is
   the window in which a second pilgrim's purchase can arrive anonymous.

   **Store those events. Never drop them** — dropping one loses the record of a payment that
   actually happened, which is the one thing this endpoint exists to prevent.

   Resolve them like this:

   - RevenueCat **aliases** the anonymous id into the same customer on the next successful `logIn`.
     After that, `aliases` on subsequent events contains both ids and `original_app_user_id` is the
     first id ever seen for that customer — which, for this pilgrim, is the anonymous one.
   - **No `TRANSFER` event is fired for aliasing.** `TRANSFER` is for a genuine move between two
     distinct customers, typically a Restore Purchases. Do not wait for one; it is not coming.
   - So: match on **any** id in `aliases`, not on `app_user_id` alone, and keep a table of
     alias → account so an event that arrives anonymous can be reconciled when the alias is later
     known. If you need to resolve one on demand, RevenueCat's REST API resolves aliases for a given
     App User ID.

3. **Do not hardcode `product_id`.** Nothing in the client pins one: `PurchaseConfig` has no
   product-id constant and the offering id is an unset `--dart-define`, because the store SKUs have
   not been chosen yet. **Key on `entitlement_ids` containing `hajjcare_pass`** — that identifier
   *is* pinned client-side (`PurchaseConfig.entitlementId`, defaulted to `hajjcare_pass`) and is the
   stable thing to match on. A rule written against a product id string will break silently the day
   the real SKU is named.

   **[Δ 2026-09-24]** "Pinned" means *defaulted*: a build can override it with
   `--dart-define=HAJJCARE_ENTITLEMENT_ID=…`. No build does today. If one ever does, the server's
   match has to change with it, so read the entitlement id from your configuration rather than
   writing the string into a handler.

4. **Only a refund revokes, and only `CUSTOMER_SUPPORT` means refund.** `CANCELLATION` carries a
   `cancel_reason`, and the possible values are `UNSUBSCRIBE`, `BILLING_ERROR`,
   `DEVELOPER_INITIATED`, `PRICE_INCREASE`, `CUSTOMER_SUPPORT`, `SUBSCRIPTION_PAUSED` and `UNKNOWN`.
   **Gate revocation on `CUSTOMER_SUPPORT` explicitly and ignore every other reason.** Treating a
   bare `CANCELLATION` as a refund would revoke a pilgrim who paid. Most of those reasons cannot
   occur for a non-renewing purchase at all, which is exactly why an unguarded handler looks correct
   in testing and is wrong in production.

   Nothing else withdraws a pass — not a failed webhook, not a missing event, not a reconciliation
   job that could not reach RevenueCat.

5. **`expiration_at_ms` is always null and must stay unused.** The pass is a non-consumable lifetime
   purchase — see CLAUDE.md § Product. Do not write an expiry column, do not compute one, and do not
   build a job that sweeps expired entitlements. An `EXPIRATION` event for this product means either
   a misconfigured dashboard or a subscription product that should not exist; log it, alert, and
   change nothing.

6. **Never trust `environment: "SANDBOX"` in production.** Sandbox and production events arrive at
   the same URL unless you configure a separate one. Store it, ignore it for entitlement.

7. **Handle `TEST` before you need it.** The dashboard's *Send test webhook* button fires a `TEST`
   event, and it is the first thing anyone will press while wiring this up. An endpoint that 500s on
   an unrecognised type makes a correctly-configured integration look broken. Return `200`.

8. **Answer fast.** Persist the raw event — raw bytes, for signature verification and for replay —
   and return `200`; do the work on a queue. The endpoint's job is to accept, not to process.

9. **Support needs to be able to look a pilgrim up.** The stated purpose of all this is answering
   "did this person pay". That needs the entitlement record joined to the account table by our
   `user.id`, and searchable by **email**, which you already hold from `POST /auth/register` — a
   support agent has an email address in front of them, not a UUID.

### What the client does with any of this today: nothing

There is no endpoint for the client to read entitlement from, and there must not be one without the
conversation in §8. The pilgrim's access is decided from their own device's database; the server's
copy exists so that support can answer "did this person pay", and so a refund has somewhere to land.

**Be clear-eyed about what that means for a refund: your revocation does not reach the handset.**
`PassRepository.deactivate` — the client's only method for withdrawing a pass — currently has **no
production caller at all**; it is exercised by tests and nothing else. `EntitlementRefresher`, the
one thing that talks to the store in the background, is built so that it can only ever *grant*: a
null answer from RevenueCat means "learned nothing", never "revoke", because a store call that fails
in Mina must not take a paying pilgrim's medication alarms away.

So today, a refunded pilgrim keeps working access on their device indefinitely. That is a deliberate
trade — the alternative risks revoking someone who paid, on a bad network, days from any way to fix
it — but it is a real gap and not something the backend can close from its side. Recording the
refund server-side is still worth doing: it is what support reads, and it is the data any future
design would build on. If we later want a refund to actually reach the handset, that is a **new**
design and a conversation, not a webhook handler.

---

## 6c. Family groups — what the backend must build

**Written 2026-09-18, ahead of the client, and that is the point.** Every other section here
describes something the app already does. This one describes something it cannot do at all: family
tracking is the first feature in HajjCare that genuinely requires a server, and the contract is the
long pole. It is here so it can be built alongside auth rather than after the client is waiting.

**Nothing in the app consumes any of this today.** The Family tab renders an honest empty state;
there is no group, no invite, no presence and no local table holding any of it. See
`docs/DECISIONS.md` § Family **[Δ 2026-09-24: moved from CLAUDE.md]** for why no table was created — an unread table that looks like group membership is worse
than none, because the next person wires a read to it.

### The honest note, which changes what is worth optimising

**This feature is unusable exactly where the app is used most.** Pilgrims lose all connectivity for
days at a time in Mina, Arafat and Muzdalifah — which is precisely when a family wants to know where
somebody is. Nothing either of us builds fixes that: it is a property of the network in the valley,
not of our design.

Two consequences for your side, and they are the reason this note is at the top rather than in a
footnote:

- **Optimise for the reconnect, not for the steady state.** A device comes back from four days dark
  with a backlog and a stale view. Getting a coherent picture in one round trip matters far more
  than sub-second freshness while a pilgrim is standing in a hotel lobby with wifi.
- **Never assume the client is current.** Every presence record carries the server's own timestamp
  and the client renders the *age* from it, always. A family member reading "200m away" about a
  figure who last reported six hours ago is being told something false at the moment it matters
  most, so the age is not an optional field and not a nicety — it is the safety property of the
  whole feature.

### Endpoints

Six, all authenticated. `Authorization: Bearer <accessToken>`, and per §3.2 **return `401` for an
expired token, never `403`** — the client's refresh-and-retry is wired to `401` alone.

| Method | Path | Purpose |
|---|---|---|
| GET | `/family/groups` | The caller's groups, members and last-known presence |
| POST | `/family/groups` | Create a group; caller becomes organiser |
| POST | `/family/groups/{groupId}/invites` | Mint a single-use, expiring invite code |
| POST | `/family/invites/{code}/accept` | Redeem a code and join |
| DELETE | `/family/groups/{groupId}/members/{userId}` | Leave, or remove if organiser |
| POST | `/family/presence` | Publish **the caller's own** position |

**Group membership is server-authoritative** (`docs/SYNC_DESIGN.md` §3). A client may *request* a
change; the server decides. A client must never be able to add itself, or anybody else, to a group —
that is the whole of what an invite code is for.

### 6c.1 Shared objects

```jsonc
// FamilyGroup
{
  "id":        "018f3c…",      // opaque, server-issued
  "name":      "Ahmad family", // pilgrim-supplied, may be null
  "organiser": "3f9a…",        // userId; the only member who may invite or remove
  "members":   [ /* FamilyMember */ ]
}

// FamilyMember
{
  "userId":      "3f9a…",
  "displayName": "Fatimah Ahmad",  // from the account; may be null
  "joinedAt":    "2026-09-14T08:11:00Z",
  "presence":    { /* Presence */ } // null when withheld — see 6c.3
}

// Presence
{
  "latitude":       21.42251,
  "longitude":      39.82621,
  "accuracyMetres": 12.5,          // never null; report the worst plausible rather than 0
  "reportedAt":     "2026-09-18T09:41:07Z"  // SERVER clock, see below
}
```

**`reportedAt` is stamped by the server, from the server's clock.** Not the client's. Two reasons,
and the second is the load-bearing one: handset clocks drift and are user-settable, and this is a
claim about **somebody else** — the reader has no way to sanity-check it the way they could a value
they typed themselves. The client may send its own `recordedAt` for diagnostics; treat it as
untrusted and never echo it as the authoritative time.

**There is no status field, and that is deliberate.** `design/16_Family.png` draws a *"Safe"* badge
and **nothing in this product defines what produces it** — self-reported, derived from heat and
movement, or something else. Until somebody decides and it is written into `docs/SPEC.md`, the
server asserts nothing about how a pilgrim *is*; it reports where a device last said it was and
when. Do not add a `status` field speculatively: a badge asserting a person is safe, with no source,
is the worst thing on this screen. See `docs/DECISIONS.md` § Family **[Δ 2026-09-24]**.

### 6c.2 Invite codes

**Read aloud, by an elderly pilgrim, over a phone line, in a crowd.** That shapes every property:

| Property | Value | Why |
|---|---|---|
| Length | **8 characters** | Long enough with the alphabet below; short enough to read twice |
| Alphabet | **Crockford base32** — no `I`, `L`, `O`, `U` | `0`/`O` and `1`/`I`/`l` are the errors this demographic actually makes |
| Case | **Case-insensitive on redeem** | The client will not force a keyboard case |
| Lifetime | **24 hours**, server-enforced | Long enough to hand over in person; short enough that a leaked code dies |
| Uses | **Single-use** | A reusable code is a group anybody who overhears it can join |
| Rate limit | **Redeem attempts per account, not per code** | Otherwise 8 characters is brute-forceable |

`POST /family/groups/{groupId}/invites` → `201`

```json
{ "code": "K7M2QX4T", "expiresAt": "2026-09-19T09:41:07Z" }
```

`POST /family/invites/{code}/accept` → `200` with the joined `FamilyGroup`.

| Status | `code` | Meaning |
|---|---|---|
| `404` | `INVITE_NOT_FOUND` | No such code. **Return this for expired and used codes too if you prefer not to distinguish** — say which, and the client will word one message |
| `410` | `INVITE_EXPIRED` | Optional, if you do distinguish |
| `409` | `ALREADY_MEMBER` | Caller is already in this group |
| `429` | `TOO_MANY_ATTEMPTS` | Rate limit; the client backs off and says so |

### 6c.3 Consent is enforced here, not on the reading device

**A member who has not agreed to share their location is returned with `presence: null`.** Not with
a position the client is trusted to hide.

This is not a preference about where to put a check. `docs/SYNC_DESIGN.md` §3 is explicit that a
permission gating *another person's* access has to be enforced somewhere that person's device does
not control, because the whole point of it is to restrain a party who would otherwise read the data.
A client-side filter over a payload that already contains the coordinates is not a permission; it is
a suggestion that ships in an APK anybody can unpack.

**The permission itself is yours to hold.** The client will cache a copy so toggles render offline,
and a change made with no signal is a queued *request*, not a fact. **Do not build the permission
model before the screen that sets it** — HajjCare has a build-failing test
(`permission_precondition_test.dart`) that refuses a permission-bearing table with no enforcing
reader, for the reason that an unenforced permission looks exactly like consent a pilgrim gave.
Tell us when you are ready and the two land together.

### 6c.4 Presence publishing is opportunistic, by design

`POST /family/presence` carries the caller's own position and nothing else.

**The client fires it unawaited and nothing waits for it.** Per CLAUDE.md § Network policy this app
has exactly four actions permitted to *require* a network — sign in, sign up, password reset, and
purchase/restore — and adding a fifth is a decision argued in the open. Presence is not one: it is
scoped like the background token refresh, so its failure has no visible effect at all, no banner and
no spinner. If your endpoint is slow or down, a pilgrim notices nothing.

Which also means: **a `500` here is cheap and a `500` on `/family/groups` is not.** The read is what
a family member is looking at.

### 6c.5 What the client will not do

Stated so you do not build for it:

- **It will not poll.** A tab that refreshes on open and on a manual pull is the plan; a background
  location stream would drain the battery the emergency button runs on.
- **It will not send health data**, and must not be able to. The spec's "dependent monitoring" — a
  guardian seeing a dependant's conditions — is a separate feature with its own consent, and the app
  has a build-failing rule (`clinical_scope_discipline_test.dart`) that forbids the family feature
  from naming a clinical repository at all.
- **It will not treat a failed read as an empty group.** No signal renders the last-known view with
  its age; it never renders "nobody is here", which would read as a family having left.

### 6c.6 Open questions for this section

Same standing as §8 — assumptions, not requirements, and each has a matching client change:

1. **Does a pilgrim belong to one group or several?** The shapes above allow several and the client
   would render the first. One is simpler for both sides if that matches the product.
2. **Who may see whom — everyone in the group, or pairwise?** The above assumes group-wide.
3. **How long do you retain presence history?** The client needs only the latest. If you keep a
   trail, say so, because that is a privacy surface the pilgrim should be told about.
4. **Does the organiser transfer on leaving?** The above does not say, and a group whose organiser
   leaves is otherwise un-inviteable for ever.

---

## 7. Non-negotiables

1. **camelCase JSON keys, request and response, everywhere in *this* API.** No mixing.
   `refreshToken`, not `refresh_token`; `expiresInSeconds`, not `expires_in_seconds`.

   **The one carve-out is the RevenueCat webhook body (§6b), which is snake_case and not ours to
   change.** `app_user_id`, `original_app_user_id`, `entitlement_ids`, `expiration_at_ms` and the
   rest arrive in RevenueCat's format. Parse them as they come; do not normalise them into our
   convention on the way in and then wonder which spelling a field has.
2. **Response bodies are bare JSON objects at the top level.** No `{"data": ...}` envelope, no
   `{"success": true, "result": ...}` wrapper.
3. **Errors carry stable machine `code` strings, and the client's logic reads only those.** Message
   text is for your logs; every user-facing word comes from the app's translation files, in seven
   languages. Renaming a code changes app behaviour in a way no message change ever will.
4. **A `401` or `403` from `/auth/refresh` is the only response in this API that logs a pilgrim
   out**, and a JSON `Content-Type` header is enough to arm it — an empty body does not make it
   safe (§3.5). Do not send either status from that endpoint for anything transient; use `429` or
   `503`.
5. **Return `401`, never `403`, for an expired access token on every other endpoint.** The client's
   refresh-and-retry is wired to `401` alone; `403` fails the request outright (§3.2).
6. **Never `404` or `409` under `/auth`** except for the two meanings in §3.2.
7. **`user.id` is stable forever, and never blank.** It keys the pilgrim's local health data —
   it is literally the `user_id` column on every user-owned table in the app's database. A
   blank or whitespace-only `id` is now rejected by the client as a malformed response and no
   session is created; a reused id would hand a new account the previous pilgrim's medication
   schedule and pass.
8. **No breaking changes to any shape, key, status or code in this document without telling me
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
   **[Δ 2026-09-26] Answered:** 60 days, sliding, configurable 45–365 (the server refuses to start
   outside it); rotated, with the previous token valid until one of its successors is used instead
   of a 60-second grace — see §4.
6. **`expiresIn` in seconds, and sent on every token response.** The client tolerates its absence.
   Confirm you will send it, or say you won't.
7. **A "sign out all devices" action.** Not designed, not in the client. If you build per-device
   refresh tokens now it will be cheap later; if you build one shared token it will not be.
   `/auth/logout` today revokes one refresh token — confirm that is what you'll implement.
   **[Δ 2026-09-26] Answered:** logout revokes that device's session — the token sent and every
   token issued from the same sign-in — and nothing on other devices. Per-device, as proposed.

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
    it and a stricter server produces a worse error experience). A *maximum* is the part worth
    discussing if your hashing has one.

**OTP and reset**

13. **600s expiry / 60s resend cooldown / 6 digits / 5 attempts.** All four are proposals except the
    digit count — `codeLength` other than 6 makes the translated copy wrong in seven languages, so
    changing it means a translation pass. The other three are just numbers; if your limiter wants
    900/30/3, say so and I'll match the countdowns.
14. **`attemptsRemaining` on a wrong code.** The client has a translated message ready — *"That code
    is not right. 2 tries left before you will need a new code."* — but **nothing parses it from the
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
    *"Too many tries. Wait a moment, then ask for a new code"* — wording written for the OTP screen,
    nonsense on a sign-in form. If you want to rate-limit login, we need a distinct error code and a
    new translated message in all seven languages. Tell me before you turn one on.
19. **Rate limiting `/auth/forgot-password`.** `429` there is safe and the wording fits. Assume a
    per-address and per-IP limit is fine unless you hear otherwise.
20. **What `/auth/refresh` does under load.** Confirm it will answer `429` or `503` and never `401`,
    since only one of those three signs a pilgrim out.
