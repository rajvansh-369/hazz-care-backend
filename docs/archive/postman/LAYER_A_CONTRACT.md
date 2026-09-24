> ARCHIVED 2026-09-24 — describes code or a contract that no longer exists. CLAUDE.md and BACKEND_SPEC.md are authoritative.

# HajjCare Backend API - Layer A Contract

This Postman collection implements the **Layer A contract** specified in `CLAUDE.md §A`. This is the frozen contract with the shipped Flutter client — no changes without coordinated client release.

## Import Instructions

1. Open Postman
2. Click **Import** → **Upload Files**
3. Select `HajjCare-LayerA.postman_collection.json`
4. Also import `HajjCare-Environment.postman_environment.json`
5. In Postman, select **HajjCare Backend - Development** from environment dropdown

## Endpoints (9 total)

All paths mount at root (`/`), not `/api/v1`.

### 1. POST /auth/register
Register new account. Returns `{tokens, user}`.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "fullName": "John Doe"
}
```

**Response (201):**
```json
{
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 900
  },
  "user": {
    "id": "...",
    "email": "user@example.com",
    "fullName": "John Doe",
    "emailVerified": true
  }
}
```

### 2. POST /auth/login
Sign in with email and password. Returns `{tokens, user}`.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response (200):**
```json
{
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 900
  },
  "user": {
    "id": "...",
    "email": "user@example.com",
    "fullName": "John Doe",
    "emailVerified": true
  }
}
```

### 3. POST /auth/refresh
Rotate refresh token. Returns `{tokens}` (user optional per spec).

**Request:**
```json
{
  "refreshToken": "..."
}
```

**Response (200):**
```json
{
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 900
  }
}
```

**Grace window:** Old token works for 60 seconds after refresh. After that, only new token valid.

### 4. POST /auth/forgot-password
Request password reset code via email. Returns countdown timers.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (200) — same for known and unknown addresses:**
```json
{
  "expiresInSeconds": 600,
  "resendAfterSeconds": 60,
  "codeLength": 6
}
```

### 5. POST /auth/verify-otp
Verify 6-digit reset code. Returns reset token.

**Request:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response (200):**
```json
{
  "resetToken": "...",
  "expiresInSeconds": 600
}
```

**Rules:**
- 5 attempts per code, then locked for 15 min
- Expired code does not consume attempt
- Resend voids old code and resets attempts

### 6. POST /auth/reset-password
Set new password using reset token. No tokens returned.

**Request:**
```json
{
  "resetToken": "...",
  "password": "NewSecurePass123!"
}
```

**Response (204):** No body. Pilgrim is sent to sign-in screen.

### 7. POST /auth/logout
Revoke single device session.

**Request:**
```json
{
  "refreshToken": "..."
}
```

**Response (204):** No body.

### 8. GET /auth/me
Get current user profile. Requires Bearer token.

**Request:**
```
Authorization: Bearer <accessToken>
```

**Response (200):**
```json
{
  "id": "...",
  "email": "user@example.com",
  "fullName": "John Doe",
  "emailVerified": true
}
```

### 9. POST /webhooks/revenuecat
Server-to-server. Client never calls this. RevenueCat posts purchase events.

**Auth:** `Authorization: Bearer <RC_WEBHOOK_SECRET>` (constant-time compare)

**Body:** Raw RevenueCat event object. Examples:
- `INITIAL_PURCHASE` / `NON_RENEWING_PURCHASE` → grant entitlement
- `TRANSFER` → move entitlement (read `transferred_from` / `transferred_to`)
- `CANCELLATION` + `cancel_reason: CUSTOMER_SUPPORT` → revoke (only revoking event)
- `EXPIRATION` → log loudly, change nothing (should never arrive; pass is lifetime)
- Others → ignore

**Response (200):** Persists raw event, processes async on BullMQ.

## Error Contract

All errors are `{code}` or `{code, errors: [{field, code, message}]}`. No other fields in body.

### Status code rules under /auth

1. **Never 404.** Routes that don't exist return 400 `{"code":"bad_request"}`
2. **Never 409 except email_taken.** All duplicate-key errors under /auth except email are 500 or 400
3. **401 on /auth/refresh means logout.** Never 401 for rate limiting, load, validation errors
4. **Never 429 on /auth/login.** Adding one needs a new error code + 7 translations

### Error codes (11 total + internal)

```
email_taken              — Email already registered
invalid_credentials      — Bad email/password or invalid session
account_not_found        — Account doesn't exist (login enumeration shield)
invalid_reset_token      — Reset token expired or already used
too_many_attempts        — OTP or rate limit lockout
otp_expired              — Code expired (does not consume attempt)
invalid_otp              — Wrong code (consumes attempt)
invalid_input            — Malformed request, validation failed
password_too_short       — Password < 8 chars
email_invalid            — Email format rejected
session_revoked          — Token revoked (e.g., password changed)

server_error             — Internal server error (500)
bad_request              — Invalid request under /auth (400)
not_found                — Resource not found (404, not under /auth)
```

### Example error responses

**Invalid email on register:**
```json
{
  "code": "email_invalid",
  "errors": [
    {
      "field": "email",
      "code": "email_invalid",
      "message": "Email must be a valid email address"
    }
  ]
}
```

**Email already taken:**
```json
{
  "code": "email_taken",
  "errors": [
    {
      "field": "email",
      "code": "email_taken",
      "message": "Email already registered"
    }
  ]
}
```

**Wrong password (login attempt 1 of 5):**
```json
{
  "code": "invalid_credentials"
}
```

**Rate limited (forgot-password):**
```json
{
  "code": "too_many_attempts"
}
```

## Testing Tips

### Set up environment
1. Import collection + environment
2. Select **HajjCare Backend - Development** environment
3. Update `baseUrl` if running on different host
4. For RevenueCat webhook testing, set `rcWebhookSecret` to your RC webhook secret

### Flow: Register → Login → Refresh → Logout
1. Run **Auth - Register** → sets accessToken, refreshToken
2. Run **Auth - Me** → verify current user (uses accessToken)
3. Run **Auth - Refresh** → rotate tokens
4. Run **Auth - Logout** → revoke session

### Flow: Password Reset
1. Run **Auth - Forgot Password** → email sent
2. Copy 6-digit code from email
3. Run **Auth - Verify OTP** with code → sets resetToken
4. Run **Auth - Reset Password** → password changed, forced to re-sign-in

### Rate limiting
- **forgot-password:** per-email + per-IP limit
- **verify-otp:** 5 attempts per code, 15 min lockout
- **login:** no limit (client feature, not server-enforced)

## Key Contracts

### User object shape
- `id` (string, opaque, stable forever)
- `email` (lowercase)
- `fullName` (nullable, text)
- `emailVerified` (boolean, default true)

Never return: `password`, `__v`, `_id`, `role`, `isActive`, `loginAttempts`

### Token object shape
- `accessToken` (15 min lifetime)
- `refreshToken` (≥45 days lifetime, proposed 60)
- `expiresIn` (seconds, optional on refresh)

### Entitlement
Lifetime, non-consumable pass. No expiry. Client reads from local database, never asks server (except support queries).

## Breaking Changes

Before making any changes to this contract:
1. Check `CLAUDE.md §A` — this IS the spec
2. Coordinate with mobile team — any change needs client release
3. Test with contract test suite in `tests/contract/`
4. Document in PR what changed and why

This collection is version-locked. Do not update without explicit approval.
