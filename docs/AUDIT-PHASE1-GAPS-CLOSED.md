# HajjCare Backend API — Audit Report — Gaps Closed

**Date:** 2026-08-30 (updated)  
**Scope:** Complete audit including stack verification, all 10 contract risk checks, response field shapes, token model capabilities, and journey/entitlement sources.

---

## STACK DISCOVERY — NOT TYPESCRIPT + PRISMA + POSTGRESQL

**Finding:** Codebase is **JavaScript + Mongoose + MongoDB**, not TypeScript + Prisma + PostgreSQL per CLAUDE.md §C1.

**Evidence:**
- `package.json` line 2: name is `"node-mongo-api-boilerplate"`
- `package.json` line 49: `"mongoose": "^8.8.0"`
- No Prisma, no PostgreSQL driver
- All source files are `.js`, not `.ts`
- Uses Jest (line 16), not Vitest
- Uses `mongodb-memory-server` for tests (line 64)

**Impact on this audit:**
- My claims about Prisma error codes (P2002, P2025) are **INVALID**
- Error handling uses Mongoose validation, not Prisma
- The stack violates CLAUDE.md §C1 requirement: "Language: TypeScript, strict: true" and "ORM: Prisma"

**Correction needed:**
- Report section A4 (Prisma P2002/P2025 mapping) is incorrect
- Section C4 needs to verify MongoDB/Mongoose duplicate-key handling instead

---

## C. CONTRACT RISKS — COMPLETE VERIFICATION

### ✓ **1. Response envelope helper present**
**Finding:** YES — present  
**File:** `src/utils/ApiResponse.js` (lines 7-17, 23-30)  
**Risk:** Every response fails to parse. App is unusable. ❌

---

### ✓ **2. Error codes in SCREAMING_SNAKE**
**Finding:** YES — present  
**File:** `src/utils/errorCodes.js` (lines 7-27)  
**Risk:** Client's error handling broken. ❌

---

### ✓ **3. Any path can emit 404 under `/auth`**
**Finding:** YES — present  
**File:** `src/middlewares/error.middleware.js` (lines 11-17)  
**Risk:** Typos render as "no account for that email". ❌

---

### ✓ **4. Any path can emit 409 under `/auth` except duplicate registration**
**Finding:** VERIFIED — only email is unique  
**File:** `src/models/user.model.js` (line 34)  
**Details:** 
- `email` has `unique: true` (line 34)
- No other fields have unique constraints
- Mongoose will throw E11000 error on duplicate email
- Error handler maps this to 409 (from `fromDuplicateKeyError` in error.middleware.js line 32-39)
- Only field capable of producing 409 on `/auth` is `email`
**Result:** SAFE — only duplicate email produces 409 ✓

---

### ✗ **5. `/auth/refresh` can return 401 for reasons other than dead token**
**Finding:** NEEDS FIXING — multiple non-token-death paths return 401

**Route:** `POST /auth/refresh` (line 55 of auth.route.js)  
**Middleware stack:** 
- `validate(authValidation.refresh)` — validates body
- No `auth()` middleware
- Affected by `generalLimiter` on router (from app.js line 98)

**All code paths that return 401:**

1. **Valid flow — dead token:**
   - `verifyJwt()` throws JWT error (expired/invalid signature) → 401 with code TOKEN_EXPIRED/TOKEN_INVALID (lines 56-62 of token.service.js) ✓
   - `verifyStoredToken()` finds no token in DB → 401 with code TOKEN_INVALID (line 102 of token.service.js) ✓
   - `verifyStoredToken()` finds expired token → 401 with code TOKEN_EXPIRED (line 108 of token.service.js) ✓
   - `refreshAuth()` user inactive → 401 with code TOKEN_INVALID (line 100 of auth.service.js) ✓

2. **ERROR — non-dead-token failure path:**
   - Validation error (malformed body) → handled by `validate()` middleware → 400 BAD_REQUEST ✓
   - Unhandled database exception (e.g., MongoDB connection fails) → caught by `errorHandler` → 500 (because not an ApiError) ✗ (would be 500, not 401, so spec-compliant)
   - Rate limiter triggered (`generalLimiter`) → 429 TOO_MANY_REQUESTS ✗ **VIOLATES SPEC** — spec says never 429 on refresh, use 503 or 429 that doesn't sign out, but this is broad limiter, not refresh-specific

**Verdict on check 5:** 
- Token-death paths return 401 correctly ✓
- Non-token paths mostly avoid 401 ✓
- BUT: Broad `generalLimiter` on router could return 429, and if rate-limited, the 429 carries error code `RATE_LIMITED` (SCREAMING_SNAKE) not `too_many_attempts` ✗

---

### ✓ **6. Rate limiting mounted on router (affects all routes)**
**Finding:** YES — present  
**File:** `src/app.js` (line 98)  
**Issue:** `app.use(config.apiPrefix, generalLimiter, routes)` applies broad limiter to entire API.  
**Risk:** 429 on `/auth/refresh` returns wrong error code. Rate limiter should be route-specific, not router-wide. ❌

---

### ✗ **7. Rate limiting on `/auth/login`**
**Finding:** YES — present  
**File:** `src/routes/v1/auth.route.js` (line 17)  
**Route:** `POST /auth/login` has `authLimiter` applied  
**Config:** `AUTH_RATE_LIMIT_MAX: 20` (from config.js line 38)  
**Spec violation:** BACKEND_SPEC.md §3.4 "Do not 429 this endpoint" and CLAUDE.md §A7 "Never 429 on `/auth/login`"  
**Result:** 429 response breaks login UX. ❌

---

### ✗ **8. Routes mounted under `/api/v1` instead of root**
**Finding:** YES — present  
**File:** `src/config/config.js` (line 19)  
**Impact:** All endpoints return 404 or wrong paths. ❌

---

### ✓ **9. Response field names — VERIFIED CAMELCASE BROKEN**
**Finding:** Fields are NOT camelCase in response; they are nested under `access` and `refresh`

**Token response shape (line 128-131 of token.service.js):**
```javascript
{
  access: { token: accessToken, expires: accessTokenExpires },
  refresh: { token: refreshToken, expires: refreshTokenExpires },
}
```

**Wrapped in ApiResponse:**
```javascript
{
  success: true,
  message: "...",
  data: {
    user: {...},
    tokens: {
      access: { token: "...", expires: Date },
      refresh: { token: "...", expires: Date }
    }
  }
}
```

**Spec expects:**
```javascript
{
  tokens: {
    accessToken: "...",
    refreshToken: "...",
    expiresIn: 900  // seconds, not Date
  },
  user: {
    id: "...",
    email: "...",
    fullName: "...",
    emailVerified: true
  }
}
```

**Current key issues:**
- Envelope wraps everything ❌
- `access.token` instead of `accessToken` ❌
- `refresh.token` instead of `refreshToken` ❌
- `expires` (Date object) instead of `expiresIn` (seconds) ❌
- Nested under `tokens.access` instead of flat `tokens` ❌

**Result:** Response parser fails. ❌

---

### ✗ **10. Refresh token TTL below 45 days**
**Finding:** YES — present  
**File:** `src/config/config.js` (line 28)  
**Default:** 30 days (violates firm floor)  
**Risk:** Pilgrims offline during Hajj lose session. ❌

---

## TOKEN MODEL ROTATION CAPABILITY — NOT SUPPORTED

**File:** `src/models/token.model.js`  
**Spec requirement:** CLAUDE.md §A4 and BACKEND_SPEC.md §4  
"If you rotate: the old token should keep working for a short grace window (60 seconds proposed) returning the current pair, rather than being invalidated instantly."

**Implementation in auth.service.js (line 104):**
```javascript
await Token.deleteOne({ _id: refreshTokenDoc._id });
```

**Missing from token schema:**
- No `replacedBy` field (to link old token to new one)
- No `revokedAt` field (for tracking revocation time)

**How spec requires it to work:**
1. Old token presented
2. Database checks: is this token blacklisted or does it have a `replacedBy` link?
3. If yes and `revokedAt` is within 60 seconds, return the current token pair
4. If older than 60 seconds, reject with 401

**Current implementation:**
- Old token is immediately deleted
- No grace window
- No way to track if a token was replaced or just revoked

**Result:** Cannot implement 60-second grace window. Implementation does not match spec. ❌

---

## GET /AUTH/ME RETURNS HARDCODED STUBS

**File:** `src/services/auth.service.js` (lines 252-262)  
**Controller:** `src/controllers/auth.controller.js` (lines 195-204)  

**Implementation:**
```javascript
const getMe = async (userId) => {
  // TODO: fetch user by id
  // TODO: fetch journey (type, season_id, departure_date, daysUntilDeparture)
  // TODO: fetch current entitlement (active pass, expires_at, source, features[])

  const user = { id: userId, phone: '+966501234567', firstName: 'Test' };
  const journey = { type: 'HAJJ', seasonId: null, daysUntilDeparture: null };
  const entitlement = { active: false, seasonCode: null, expiresAt: null, source: null };

  return { user, journey, entitlement };
};
```

**Sources of journey and entitlement:**
- **journey:** HARDCODED stub, no database model, no service layer
- **entitlement:** HARDCODED stub, no database model, no service layer
- **user:** TODO comment says fetch by id, but implementation uses userId to build stub

**Database models:**
- No `Journey` model found
- No `Entitlement` model found
- These are Layer B (blocked on B1 — health-data decision)

**Impact:**
- `/auth/me` returns fake data for 2/3 of response fields
- Not suitable for production
- Response structure violates spec (wrapped + wrong shape + stub data)

---

## EMAIL SERVICE — AWAITS BUT DOESN'T QUEUE

**File:** `src/services/email.service.js` (lines 16-23)  
**Implementation:**
```javascript
const send = async ({ to, subject, text }) => {
  logger.info('Outbound email (no provider configured, logged only)', {
    to,
    subject,
    preview: config.isProduction ? '[redacted]' : text,
  });
  return { delivered: false, provider: 'noop' };
};
```

**Usage in controller (auth.controller.js line 75):**
```javascript
await emailService.sendResetPasswordEmail(user.email, token);
```

**Issues:**
1. Email service is a stub (no provider configured)
2. Controller **awaits** the email send (line 75)
3. Spec requires enqueueing (async job), not awaiting SMTP

**Current behavior:** Fast enough because stub returns immediately  
**Future behavior:** When real provider is added, endpoint will wait on SMTP delivery ❌

**Spec requirement (BACKEND_SPEC.md §2 and §3.6):**
"In particular `/auth/forgot-password` must **enqueue** the email and answer immediately rather than waiting on SMTP."

---

## Summary of All Findings

| Check | Status | Severity | File | Issue |
|-------|--------|----------|------|-------|
| Stack compliance | ❌ FAIL | CRITICAL | package.json | JavaScript+Mongoose, not TypeScript+Prisma |
| Response envelope | ❌ PRESENT | CRITICAL | ApiResponse.js | Blocks all endpoints |
| Error codes | ❌ PRESENT | CRITICAL | errorCodes.js | SCREAMING_SNAKE instead of lowercase |
| 404 under /auth | ❌ PRESENT | CRITICAL | error.middleware.js | notFoundHandler returns 404 |
| 409 safe | ✓ VERIFIED | OK | user.model.js | Only email unique ✓ |
| 401 on refresh | ✓ VERIFIED | OK | token.service.js | Token-death paths OK, but rate limiter risk |
| Router rate limiter | ❌ PRESENT | CRITICAL | app.js | Broad limiter affects all routes |
| Rate limit on /login | ❌ PRESENT | CRITICAL | auth.route.js | Violates spec |
| Routes at /api/v1 | ❌ PRESENT | CRITICAL | config.js | Wrong base path |
| Token field names | ❌ WRONG | CRITICAL | token.service.js | Nested/wrong names |
| Refresh TTL | ❌ SHORT | CRITICAL | config.js | 30 days < 45 days floor |
| Token rotation grace | ❌ MISSING | CRITICAL | token.model.js | No replacedBy/revokedAt fields |
| Email enqueueing | ❌ AWAITS | HIGH | auth.controller.js | Awaits instead of queuing |
| Journey/entitlement | ❌ STUBS | HIGH | auth.service.js | Hardcoded fake data, no models |

---

## Awaiting Approval Before Fixes

No changes made. Report complete. Ready for deletions and rewrites.
