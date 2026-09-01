# Phase 3 → Phase 4 Bridge Document

## Completion Status

**Phase 3 (Data Layer) Complete:** ✓ All 5 Layer A models aligned to §A8; 111 tests passing.

**Phase 4 (Services Layer) Blockers:** Three critical field-name mismatches in `token.service.js` prevent safe token rotation.

---

## Critical Blocker: Token Rotation Unsafe

**Current state:** Services use wrong field names. Refresh tokens cannot be stored or verified.

### Issue #1: Field name `token` → `tokenHash`

**Model definition (correct per §A8):**
```javascript
tokenHash: {
  type: String,
  required: true,
  unique: true,
  private: true,
}
```

**Service code (WRONG):**
```javascript
// Line 77: saveToken()
Token.create({
  token: hashToken(token),        // ❌ Model field is tokenHash, not token
  user: userId,
  ...
});

// Line 96: verifyStoredToken()
Token.findOne({
  token: hashToken(token),        // ❌ Query on non-existent field
  ...
});
```

**Impact:** Token storage fails silently or throws; verification never finds token; refresh = always 401.

**Fix:** Rename `token` → `tokenHash` everywhere in token.service.js.

---

### Issue #2: Field name `expires` → `expiresAt`

**Model definition (correct per §A8):**
```javascript
expiresAt: {
  type: Date,
  required: true,
}
```

**Service code (WRONG):**
```javascript
// Line 79: saveToken()
Token.create({
  expires,                        // ❌ Model field is expiresAt, not expires
  ...
});

// Line 106: verifyStoredToken()
if (tokenDoc.expires.getTime() <= Date.now()) {  // ❌ Field is undefined
  throw 401;
}

// Line 169: purgeExpiredTokens()
Token.deleteMany({
  expires: { $lt: new Date() }    // ❌ Query on non-existent field
});
```

**Impact:** Expiry checks fail; cleanup job doesn't delete expired tokens; token lifetime validation broken.

**Fix:** Rename `expires` → `expiresAt` everywhere in token.service.js (3 places).

---

### Issue #3: No Grace Window Implementation

**Model provides grace window fields (correct per §A4):**
```javascript
revokedAt: {
  type: Date,
  default: null,
}
replacedBy: {
  type: mongoose.SchemaTypes.ObjectId,
  ref: 'Token',
  default: null,
}
```

**Service code (deletes instead of rotating):**
```javascript
// Line 104-107: refreshAuth()
await Token.deleteOne({ _id: refreshTokenDoc._id });  // ❌ Destroys old token
const tokens = await tokenService.generateAuthTokens(user, meta);
return { user, tokens };

// Should instead:
// 1. Create NEW token
// 2. Link old token: oldToken.replacedBy = newToken._id
// 3. Keep old alive: oldToken.revokedAt = null (stays null for 60s)
// 4. After 60s, mark: oldToken.revokedAt = now (or let TTL cleanup)
```

**Why this matters (§A4):**
- Two uncoordinated client callers: background refresher (~6h) + 401 interceptor
- If old token deleted immediately, second caller retries → always fails
- 60s grace window: old token kept alive so both callers succeed
- After 60s, old token revoked or TTL-deleted (safe)

**Query pattern for grace window:**
```javascript
// Accept token if:
// 1. Current (not rotated): replacedBy === null
// 2. Rotated but in grace window: replacedBy exists AND revokedAt === null
const tokenDoc = await Token.findOne({
  tokenHash: hashToken(token),
  type: 'refresh',
  $or: [
    { replacedBy: null },                           // Not rotated
    { replacedBy: { $exists: true }, revokedAt: null } // In grace window
  ]
});
```

**Impact:** Token rotation not safe for retry. Random logouts when refresh call is interrupted.

**Fix:** 
1. Create new token pair
2. Set `oldToken.replacedBy = newToken._id`
3. Keep `oldToken.revokedAt = null` (don't delete)
4. Return new tokens
5. Cleanup: after 60s, mark old token revoked or let TTL delete

---

## Other Field Mismatches (Phase 4 cleanup)

### Line 81: `blacklisted` field doesn't exist
```javascript
// WRONG
Token.create({
  blacklisted: false,  // ❌ Model uses revokedAt, not blacklisted
  ...
});

// Line 99: querying wrong field
Token.findOne({
  blacklisted: false,  // ❌ Should be: revokedAt: null
  ...
});
```

**Fix:** Remove `blacklisted` field; use `revokedAt: null` for "not revoked" checks.

### Lines 82-83: Non-existent fields `ip`, `userAgent`
```javascript
// WRONG
Token.create({
  ip: meta.ip || null,        // ❌ Not in model
  userAgent: meta.userAgent || null,  // ❌ Not in model
  ...
});
```

**Fix:** Remove these fields (audit trail belongs in separate AuditLog model if needed, not here).

---

## Summary: Phase 4 First Steps

1. **Rename field references in token.service.js:**
   - `token` → `tokenHash` (3 occurrences)
   - `expires` → `expiresAt` (3 occurrences)

2. **Remove non-existent fields from saveToken():**
   - Delete `blacklisted: false` line
   - Delete `ip`, `userAgent` lines
   - Keep only: `tokenHash`, `user`, `expiresAt`, `type`

3. **Update verification to use revokedAt:**
   - Line 99: `blacklisted: false` → `revokedAt: null`
   - Line 106: `tokenDoc.expires` → `tokenDoc.expiresAt`

4. **Implement grace window in refreshAuth():**
   - Don't delete old token
   - Set `oldToken.replacedBy = newToken._id`
   - Keep `oldToken.revokedAt = null`
   - After 60s, mark revoked or let TTL cleanup

5. **Fix purgeExpiredTokens():**
   - Line 169: `expires: { $lt: new Date() }` → `expiresAt: { $lt: new Date() }`

---

## Test Impact

Once Phase 4 services are fixed, re-run:
```bash
npm test -- tests/models/token.model.test.js  # Already passing (111/111)
# Add Phase 4 service tests for:
# - Token storage with correct field names
# - Verification with grace window
# - Rotation without deleting old token
# - 60s grace window retry safety
```

---

## Layer A Contract Preserved

Token model is **100% compliant with §A8** and ready for Phase 4 services to use correctly. No model changes needed; only service rewrites.
