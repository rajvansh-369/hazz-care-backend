# PasswordResetOtp Model — Layer A Contract Compliance

## Overview
Stores OTP codes for the 4-call password reset flow per §A6. **Email-keyed, not user-keyed** — allows identical responses for registered/unregistered addresses (enumeration safety).

## Required Fields (§A8)

| Field | Type | Layer A Purpose |
|-------|------|-----------------|
| `email` | String | Primary key (indexed). Lowercase normalized. Allows multiple OTPs per email (resend voids old). |
| `codeHash` | String | Unique hash of 6-digit code. **Private (never sent).** Stored hashed; DB dump cannot crack codes. |
| `expiresAt` | Date | 600s lifetime (10 min). TTL-indexed; auto-delete after expiry. Always checked in code too. |
| `attempts` | Number | Failed attempt counter (default: 0). Resets to 0 on resend. Caps at 5 before lockout. |
| `lockedUntil` | Date (optional) | Lockout timestamp if 5 failed attempts. Check *before* validating code. |
| `consumedAt` | Date (optional) | When code was used. Single-use enforcement: prevent reuse. |
| `createdAt`, `updatedAt` | Date | Timestamps. |

## The 4-Call Flow (§A6)

```
1. POST /auth/forgot-password { email }
   → 200 { expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 }
   [Enqueue email, store PasswordResetOtp, return immediately]

2. POST /auth/verify-otp { email, code }
   → 200 { resetToken, expiresInSeconds: 600 }
   [Validate code (5 attempts, check lockout first), issue 10-min reset token]

3. POST /auth/reset-password { resetToken, password }
   → 204 (no tokens, no body)
   [Mark code consumed, update password, revoke all refresh tokens]

4. Client signs in normally via POST /auth/login
```

## Enumeration Safety (§A6)

**Critical:** Never leak whether an email is registered.

### forgot-password endpoint
```javascript
// CORRECT: identical response for known and unknown addresses
POST /auth/forgot-password { email: 'attacker@test.com' }
→ 200 { expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 }

POST /auth/forgot-password { email: 'admin@real.com' }
→ 200 { expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 } // same body
```

Pattern: Enqueue mail (never await SMTP), return identical body. Keep unknown-address path doing comparable work (timing constant).

### verify-otp endpoint
```javascript
// CORRECT: same error for unknown address and wrong code
POST /auth/verify-otp { email: 'attacker@test.com', code: '123456' }
→ 400 { code: 'invalid_otp', errors: [...] }

POST /auth/verify-otp { email: 'real@user.com', code: 'wrongcode' }
→ 400 { code: 'invalid_otp', errors: [...] } // same code, same message
```

Pattern: Query PasswordResetOtp by email. If not found, return `invalid_otp` (not 404, not `account_not_found`).

## The 5-Attempt Lockout (§A6)

**Rules that are easy to get wrong:**

### 1. Check lockout BEFORE code
```javascript
if (otp.lockedUntil && otp.lockedUntil > now) {
  throw 429 TOO_MANY_ATTEMPTS; // Before checking code!
}
```
Reason: Locked-out pilgrim typing the *right* code should still be told to wait. Otherwise lockout is decorative.

### 2. Expired code doesn't consume attempt
```javascript
if (otp.expiresAt < now) {
  throw 400 OTP_EXPIRED; // Don't increment attempts
}
```
Reason: Charging an attempt punishes a pilgrim for a clock, not their typing.

### 3. Resend voids previous attempts
```javascript
// Old OTP doc gets deleted on resend (or kept for audit, marked consumed)
// New OTP doc has attempts: 0
```
Reason: Resend button rescues a locked-out pilgrim by resetting attempts. Separate rate limit on resends themselves is OK.

### 4. Five attempts, not three
```javascript
if (otp.attempts >= 5) {
  otp.lockedUntil = new Date(now + 15 * 60 * 1000); // 15 min lockout
  await otp.save();
  throw 429 TOO_MANY_ATTEMPTS;
}
```
Reason: Pilgrims reading 6 digits off phone screen in bright sun. Two slips = support call, not a security win.

### 5. Reset token is never a session
```javascript
// reset-password endpoint returns NO TOKENS, only 204
POST /auth/reset-password { resetToken, password }
→ 204 (no body, no tokens)
// Pilgrim must sign in normally
```
Reason: Typing new password on sign-in screen proves they know it. Reset token is transport-only, not session.

## codeLength Contract (§A6)

**Always return `codeLength: 6` in responses.** Hardcoded in all 7 translated copies: "a six-digit code."

```javascript
// Client-facing response
{ expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 }
```

Changing to 4 or 8 makes the translated text lie in every locale.

## Single-Use Enforcement

```javascript
// On verify-otp success, before issuing resetToken:
otp.consumedAt = new Date();
await otp.save();

// Prevent reuse: check consumedAt before allowing reset-password
if (resetToken.otp.consumedAt !== null) {
  throw 400 INVALID_RESET_TOKEN;
}
```

## Resend Behavior

Per §A6: "A resend voids the previous code and resets attempts to zero."

```javascript
// OLD (WRONG): mark old one expired
otp.expiresAt = new Date(); // Already expired, won't work

// CORRECT: delete old, create new with fresh counters
await PasswordResetOtp.deleteMany({ email });
const newOtp = await PasswordResetOtp.create({
  email,
  codeHash: hashCode(code),
  expiresAt: new Date(now + 600_000), // Fresh 600s
  attempts: 0, // Reset
});

// Return fresh counters every time (even on resend)
{ expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 }
```

**Not remainder:** Client renders live countdown from these numbers. Always send fresh 600, not `expiresAt.getTime() - now.getTime()`.

## Query Patterns for Phase 4

### Forgot-password (enqueue email, no DB check needed for enumeration safety)
```javascript
const otp = await PasswordResetOtp.create({
  email: email.toLowerCase(),
  codeHash: hashCode(code),
  expiresAt: new Date(Date.now() + 600_000),
  attempts: 0,
});
// Return 200 with same body for all addresses
```

### Verify-otp (find by email, check state before code)
```javascript
const otp = await PasswordResetOtp.findOne({
  email: email.toLowerCase(),
  expiresAt: { $gt: new Date() },
  consumedAt: null,
});

if (!otp) {
  throw 400 INVALID_OTP; // Unknown address or consumed
}

if (otp.lockedUntil && otp.lockedUntil > new Date()) {
  throw 429 TOO_MANY_ATTEMPTS; // Check BEFORE code
}

if (!constantTimeCompare(hashCode(code), otp.codeHash)) {
  otp.attempts += 1;
  if (otp.attempts >= 5) {
    otp.lockedUntil = new Date(Date.now() + 15 * 60_000);
  }
  await otp.save();
  throw 400 INVALID_OTP;
}

// Success: return resetToken
otp.consumedAt = new Date();
await otp.save();
```

### Reset-password (find by email via resetToken lookup)
```javascript
// resetToken payload contains email; verify it
const tokenEmail = decodeToken(resetToken).email;
const otp = await PasswordResetOtp.findOne({ email: tokenEmail, consumedAt: null });

if (!otp) {
  throw 400 INVALID_RESET_TOKEN;
}

// Mark consumed, update password, revoke all refresh tokens (atomic transaction)
otp.consumedAt = new Date();
await otp.save();
// Then update user password + revoke tokens
```

## Security Notes

- **codeHash is private:** Excluded from JSON by toJSON plugin.
- **Never log code values:** Only log hashes.
- **Timing constant comparison:** Use `constantTimeCompare` to prevent timing attacks on code verification.
- **No code in URLs:** Always in body to avoid log leaks.

## Test Coverage

See `tests/models/passwordResetOtp.model.test.js` for:
- 5-attempt lockout with order-of-checks enforcement
- Enumeration safety patterns (same response for known/unknown)
- Single-use consumption tracking
- Resend behavior (reset attempts, fresh TTL)
- Email as primary key (not user)
- codeLength contract
- Query patterns needed by Phase 4 services
