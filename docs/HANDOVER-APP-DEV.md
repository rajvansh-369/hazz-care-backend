# HajjCare API — handover for the Flutter app

The backend implements the eight `/auth` endpoints in `BACKEND_SPEC.md` §3 exactly as the app
calls them today. Nothing on the client needs to change. This page records the answers to the
spec's §8 open questions as implemented, and what is not done yet.

## Base URL

```
https://api-staging.healthhub4u.co.uk/api/v1
```

**Live once the staging deployment is verified with `docs/DEPLOY-CHECKLIST.md`.** Until then the
hostname may not answer, or may answer with a server that is still being checked.

```bash
flutter run --dart-define=HAJJCARE_API_BASE_URL=https://api-staging.healthhub4u.co.uk/api/v1
```

Paths are appended verbatim (`…/api/v1/auth/login`), as §2 describes. The `/api/v1` prefix is
the §8 item 2 option: it lives in the base URL, so the client needs no change.

**If the app seems not to call the server at all**, it is running against the built-in mock.
Force the real client with `--dart-define=HAJJCARE_USE_MOCK_BACKEND=false`.

## Decisions on BACKEND_SPEC §8, as implemented

| § 8 item | Decision |
|---|---|
| 1. Key casing | camelCase, request and response |
| 2. Path prefix | `/api/v1`, carried in the base URL |
| 3. Register status | **`201`** |
| 4. Access token lifetime | **900 s** (15 min) |
| 5. Refresh token | **60 days, rotated on every refresh, with a 60-second grace window**: the previous refresh token keeps returning a valid pair for 60 s after it was rotated, so the background refresher and the 401 interceptor can race safely |
| 6. `expiresIn` | **Always sent** on register, login and refresh, in seconds |
| 7. Logout | Revokes **that one device's** refresh token. Always `204`, including `{"refreshToken": ""}`. No "sign out all devices" |
| 8. `user.id` | Opaque string (a MongoDB ObjectId in hex), stable forever, identical on register, login and `/auth/me` |
| 9. `emailVerified` | **Always `true`**. There is no verification flow |
| 10. `fullName` | Optional; `null` accepted and returned as `null`. Trimmed; a blank name becomes `null` |
| 11. Email case | **Trimmed and lowercased server-side**. `Pilgrim@x.com` and `pilgrim@x.com` are one account |
| 12. Password | **Min 8 characters, no maximum, no composition rules, never trimmed, never truncated** (argon2id) |
| 13. OTP | **600 s expiry, 60 s resend cooldown, 6 digits, 5 attempts.** A resend voids the old code and resets the attempts. An expired code does not use up an attempt. The lockout is checked before the code |
| 14. `attemptsRemaining` | **Not sent** |
| 15. `Retry-After` on 429 | **No change.** The app does not read `Retry-After`. The per-IP limiters' `429`s already send it (seconds, plus `RateLimit`/`RateLimit-Policy`); the per-address forgot-password `429` and the OTP lockout `429` do not, and need not |
| 16. Reset token | **600 s, single-use**. `verify-otp` returns a reset token only, never a session; `reset-password` returns `204` with no tokens |
| 17. Email language | **English only**, see below |
| 18. Login brute-force protection | **None: no `429` on login or register, ever** |
| 19. Forgot-password limits | 5 codes per address per hour, plus a per-IP limit → `429 too_many_attempts` |
| 20. Refresh under load | `429` or `503`, never `401`. Only a genuinely dead refresh token gets `401 {"code":"session_revoked"}` |

Other shapes, all as §3 says: `/auth/me` returns a **bare** AuthUser (no `{"user": …}`); refresh
returns `{ "tokens": {…} }` with no `user`; every body is a bare JSON object; unknown paths under
`/auth` answer `503 {"code":"unavailable"}`, never `404`.

## Known limitations

- **The OTP email is English only**, because the app sends no locale (§8 item 17). Localised
  emails need the app to send one first (a header or a field on `forgot-password`).
- TODO: nothing in the family-group section (§6c) is built. It waits for the client screen.

## Creating a test account on staging

Register from the app, or:

```bash
curl -i -X POST https://api-staging.healthhub4u.co.uk/api/v1/auth/register \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"you+hajjcare-test@example.com","password":"correct horse battery","fullName":"Test Pilgrim"}'
```

`201` means the account exists; `409 email_taken` means it already did. Use an address whose
inbox you can read, so the password-reset flow can be tested end to end.

A Postman collection with all eight requests, each with the contract checks, is in `postman/`.
For staging set `baseUrl` to the staging URL, leave `mailpitUrl` empty and put the emailed reset
code into `otpCode` by hand (folder 5, the OTP lockout, needs Mailpit and runs only locally).

TODO: who to contact for staging access, and where staging's logs are.
