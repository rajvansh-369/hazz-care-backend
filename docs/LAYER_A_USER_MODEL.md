# User Model — Layer A Contract Compliance

## Overview
The User model has been refactored to match the Layer A contract per CLAUDE.md §A8.

## Required Fields (§A8)

| Field | Type | Notes |
|-------|------|-------|
| `id` | String | MongoDB _id converted to string via toJSON transform (opaque, stable, identical across register/login/refresh/me) |
| `email` | String | Unique, lowercase, trimmed, required |
| `passwordHash` | String | Private (excluded from JSON), bcrypt-hashed, 8+ chars, no composition rules |
| `fullName` | String\|null | Optional, max 80 chars |
| `emailVerified` | Boolean | Default: true |
| `createdAt` | Date | ISO string in JSON |
| `updatedAt` | Date | ISO string in JSON |

## Removed Fields

The following fields were in the old model but **not in the Layer A contract**. They have been removed:

### Name Fields
- `name` (required) → replaced with `fullName` (optional)
- `firstName` → consolidated into `fullName`
- `lastName` → consolidated into `fullName`

### Health/Personal Data (Layer B blocked on decision)
- `phone`
- `dob` (date of birth)
- `gender`
- `countryCode`
- `bloodType`
- `heightCm`, `weightKg`

### Localization (not in Layer A)
- `locale`

### Authorization (Layer B decision)
- `role`

### Account State (not in Layer A contract)
- `isActive` — clients stay logged in 45 days with zero refreshes; no server-side logout
- `isEmailVerified` → renamed to `emailVerified` (casing only; removed flag logic)
- `loginAttempts`, `lockUntil`, `lastLoginAt` — brute force protection not in Layer A

## Changes Made

### Field Renames
- `password` → `passwordHash` (field name, same purpose)
- `isEmailVerified` → `emailVerified` (casing alignment)

### Validation Changes
- **Password**: removed composition rules (old: uppercase + lowercase + digit + special char)
  - New rule: bcrypt or argon2id, min 8 characters, **no maximum, no composition rules**
  - Reason: Server stricter than client turns inline-passable rules into opaque server errors

### Removed Methods/Features
- `isLocked()` — brute force detection (not in Layer A)
- `registerFailedLogin()` — brute force tracking (not in Layer A)
- `registerSuccessfulLogin()` — login auditing (not in Layer A)
- `paginate` plugin — no pagination in Layer A
- `role` index — removed with role field

### Preserved Methods
- `isPasswordMatch(candidatePassword)` — bcrypt comparison ✓
- `isEmailTaken(email, excludeUserId)` — duplicate check ✓
- pre-save hash hook — bcrypt with config salt rounds ✓

## toJSON Transform Compliance

The toJSON plugin transforms documents before sending to client:

```javascript
input:  { _id: ObjectId("..."), passwordHash: "bcrypt...", email: "...", __v: 0 }
output: { id: "6a96cb0e052bc2647b2ee4f2", email: "...", ... }
        // _id → id (string)
        // passwordHash, __v removed
        // Dates converted to ISO strings
```

**Critical for Layer A:** `user.id` must be JSON string, not integer. Pilgrim's entire local health database is keyed by this value (CLAUDE.md §A8).

## Config Support

- `MONGODB_REPLICA_SET` env var added for transaction support (password reset atomicity)
- `BCRYPT_SALT_ROUNDS` configurable (default 12, range 10-15)

## Phase 4 Blockers

The following service files reference removed fields and need updates:

1. `src/services/auth.service.js`
   - Lines 32, 38, 48, 52, 98, 115: `isActive` checks → remove (always active per Layer A)
   - Lines 38, 48, 52: `isLocked()`, `registerFailedLogin()`, `registerSuccessfulLogin()` → remove
   - Lines 136-137: `loginAttempts`, `lockUntil` → remove
   
2. `src/services/token.service.js`
   - Line 121: `role: user.role` → remove (access token doesn't use role in Layer A)

These must be fixed before Phase 4 services can be tested against Layer A contract.

## Test Coverage

See `tests/models/user.model.test.js` for:
- `user.id` is a JSON string
- `passwordHash` excluded from JSON
- Contract fields preserved in JSON
- No boilerplate fields leak to client
