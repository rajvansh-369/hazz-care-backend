# Token Model — Layer A Contract Compliance

## Overview
Token model stores refresh and reset-password tokens per Layer A contract (CLAUDE.md §A8).

## Required Fields (§A8)

| Field | Type | Layer A Purpose |
|-------|------|-----------------|
| `tokenHash` | String | Unique hash of the token. **Private (not sent to client).** Stored hashed so database dump cannot be replayed. |
| `user` | ObjectId ref | Reference to User. Indexed for efficient revocation queries (logout all). |
| `type` | String enum | `'refresh'` \| `'resetPassword'` only. Access tokens NOT stored (stateless JWT). |
| `expiresAt` | Date | TTL-indexed; MongoDB auto-deletes expired tokens. Always checked in code as well (not just garbage collection). |
| `revokedAt` | Date (optional) | Marks token as revoked without deletion. Enables tracking (audit logs, grace window). |
| `replacedBy` | ObjectId ref (optional) | Token rotation grace window. Old token kept alive 60s after rotation so client retries work. |
| `createdAt`, `updatedAt` | Date | Timestamps for audit. |

## Constraints per §A8

### Type Enum: Refresh + Reset Only
```javascript
enum: ['refresh', 'resetPassword']
```
- **`refresh`**: Long-lived (≥45d, proposed 60d). Rotated with 60s grace window.
- **`resetPassword`**: Short-lived (10min, single-use). Not a session.
- **NOT stored**: `access` (stateless JWT), `verifyEmail` (Layer B email verification).

### Unique Constraint: tokenHash
- Prevents duplicate token storage.
- Enables idempotency: retry a `/auth/refresh` call, same token hash → already processed.

### Index: user + query patterns
```javascript
// Query to revoke all refresh tokens for a user on logout-all or password change
Token.deleteMany({ user: userId, type: 'refresh' })

// Query to find non-revoked token for verification
Token.findOne({
  tokenHash: hashToken(token),
  type: 'refresh',
  user: userId,
  revokedAt: null,
  expiresAt: { $gt: new Date() }
})
```

### TTL Index: Auto-cleanup
```javascript
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```
- MongoDB deletes documents immediately after `expiresAt` passes.
- Lazy cleanup (~1 min interval); never rely on it for correctness.
- Always check `expiresAt` in code; TTL is garbage collection only.

## 60-Second Grace Window (§A4)

**Why:** Two uncoordinated client callers exist — background refresher (~6h) and 401 interceptor. If one succeeds before the other checks, reuse detection would sign out randomly.

**How:** Keep old token alive for 60s after rotation:

```javascript
// Current implementation pattern (Phase 4 service will implement)
oldToken.replacedBy = newToken._id;
oldToken.revokedAt = null;  // Keep alive 60s
await oldToken.save();
// After 60s, mark as revoked (or let TTL clean it, or explicit sweep job)
```

**Query to support grace window:**
```javascript
// Accept token if it's either:
// 1. Current (not replaced)
// 2. Replaced recently (within grace window)
Token.findOne({
  tokenHash: hashToken(token),
  $or: [
    { replacedBy: null },                           // Not rotated yet
    { replacedBy: { $exists: true }, revokedAt: null } // Rotated, in grace window
  ]
})
```

## Layer A Contract: NOT in Token Model

- **No access token storage** — JWT signature verification is enough; database is for durable tokens only.
- **No verify-email tokens** — Layer B decision (email verification not in signed client).
- **No login attempt tracking** — Not in Layer A contract. Brute force protection is a Phase 4 decision.
- **No `blacklisted` flag** — Use `revokedAt` for state; `expiresAt` for lifecycle.

## Security

- **tokenHash is private:** Excluded from JSON responses by toJSON plugin.
- **Never log token values:** Only log hashes.
- **Single-use reset token:** Once verified, mark consumed. Check phase 4 services.

## Phase 4 Implementation Notes

### Service Layer Must Implement

1. **Token Generation** (`generateAuthTokens`, `generateResetPasswordToken`)
   - Generate secure random token
   - Hash token with SHA256 before storage
   - Create Token document with tokenHash, expiresAt, type
   - Return raw token to client (never stored hash is sent)

2. **Token Verification** (`verifyStoredToken`)
   - Check JWT signature (never touches DB)
   - Find Token doc by tokenHash + user + type + expiresAt > now
   - If found and not revoked, return user; else throw 401

3. **Token Rotation** (`refreshAuth`)
   - Verify current refresh token
   - Create new token pair (new refresh + access)
   - Set old token `replacedBy = newToken._id`
   - Keep old token alive (revokedAt = null) for 60s grace
   - Return new tokens

4. **Token Revocation** (logout, password reset)
   - `Token.deleteMany({ user, type: 'refresh' })` for logout-all
   - Or mark `revokedAt = now` if audit trail needed
   - Check if TTL index handles cleanup or if sweep job needed

## Test Coverage

See `tests/models/token.model.test.js` for:
- Type enum enforcement
- tokenHash uniqueness & privacy
- Grace window fields (replacedBy, revokedAt)
- TTL index configuration
- User ref indexing
- Query patterns needed by Phase 4 services
