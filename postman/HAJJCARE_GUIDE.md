# HajjCare - Postman Collection Guide

> **Product:** HajjCare — Your Health. Your Hajj. Your Peace of Mind.
> **Auth:** Phone-first OTP (6 digits, 5-min TTL, max 5 attempts)
> **Framework:** Express + Node.js 20 LTS
> **Per:** CLAUDE.md specification

---

## Quick Start

### 1. Import Collection
```
Postman → Import → Upload Files
→ HajjCare-API.postman_collection.json
```

### 2. Set Environment
Edit collection variables (top-right gear icon):
- `baseUrl` → `http://localhost:3000/api/v1` (dev)
- `accessToken` → (auto-filled after verify OTP)
- `refreshToken` → (auto-filled after verify OTP)

### 3. Authentication Flow
```
1. Request OTP    → { phone, locale } → { challengeId, expiresIn }
2. Verify OTP     → { challengeId, code } → { accessToken, refreshToken }
3. Register Device → store push token for notifications
4. Use accessToken → all protected routes auto-inject Bearer token
```

---

## Auth Endpoints (§4 — CLAUDE.md)

### Request OTP
```
POST /auth/otp/request
Content-Type: application/json

{
  "phone": "+966501234567",     // E.164 format: +[country][number]
  "locale": "ar"                // en|ar|ur|id|fr|bn|tr
}

→ { challengeId, expiresIn }   // challengeId = UUID, expiresIn = 300 (5 min)
```

**Rate limit:** 5 per 15 min per phone  
**Lockout:** 15 min after 5 failed attempts on same phone + IP

---

### Verify OTP
```
POST /auth/otp/verify
Content-Type: application/json

{
  "challengeId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "code": "123456"              // 6 digits, sent to phone
}

→ {
    "accessToken": "eyJhbGc...",        // JWT, 15 min TTL
    "refreshToken": "eyJhbGc...",       // JWT, 30 day, rotating (single-use)
    "isNewUser": false                  // true = first-time signup
  }
```

**Auto-stores** tokens in collection variables via test script.  
**New users** get account created on first OTP verification.

---

### Register Device
```
POST /auth/devices
Authorization: Bearer {{accessToken}}
Content-Type: application/json

{
  "pushToken": "ExponentPushToken[xxx]",
  "platform": "ios",            // ios|android|web
  "appVersion": "1.0.0",
  "locale": "ar"
}

→ { success: true }
```

Stores push token for Firebase Cloud Messaging. Called after login to enable notifications.

---

### Get Auth Context (me)
```
GET /auth/me
Authorization: Bearer {{accessToken}}

→ {
    "user": { ... },
    "journey": { ... },           // journey = type, season_id, daysUntilDeparture
    "entitlement": { ... }        // active pass info
  }
```

Returns current user + journey + entitlement summary for dashboard.

---

### Refresh Access Token
```
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "{{refreshToken}}"
}

→ {
    "accessToken": "eyJhbGc...",   // new access token (15 min)
    "refreshToken": "eyJhbGc..."   // rotated refresh token (single-use!)
  }
```

**Rotating tokens:** each refresh returns a new refresh token. Old one becomes invalid.  
**Reuse detection:** using a refresh token twice = security incident, revokes entire device family + logs.

---

### Logout
```
POST /auth/logout
Content-Type: application/json

{
  "refreshToken": "{{refreshToken}}"
}

→ { success: true }
```

Revokes single device session. Refresh token becomes invalid.

---

## User Profile Endpoints (§3 — CLAUDE.md)

### User Model Fields
```
Required:
- phone           E.164 format: +966501234567 (unique per user)
- firstName
- lastName

Optional:
- email
- dob             ISO 8601 date: 1980-05-15
- gender          male|female|other
- locale          en|ar|ur|id|fr|bn|tr
- countryCode     ISO 3166-1 alpha-2: SA, US, GB, etc.
- status          active|inactive|suspended
- pushTokens[]    array, managed via /auth/devices
- lastSeenAt      timestamp, auto-updated
- lastKnownLocation   PostGIS geography point (Mina, Arafat, etc.)
```

---

### Get My Profile
```
GET /users/me
Authorization: Bearer {{accessToken}}

→ {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "phone": "+966501234567",
    "firstName": "Ahmed",
    "lastName": "Al-Mansouri",
    "email": "ahmed@example.com",
    "dob": "1980-05-15",
    "gender": "male",
    "locale": "ar",
    "countryCode": "SA",
    "status": "active",
    "pushTokens": ["ExponentPushToken[xxx]"],
    "lastSeenAt": "2024-08-29T12:34:56Z",
    "createdAt": "2024-08-20T10:00:00Z",
    "updatedAt": "2024-08-29T12:34:56Z"
  }
```

---

### Update My Profile
```
PATCH /users/me
Authorization: Bearer {{accessToken}}
Content-Type: application/json

{
  "firstName": "Ahmed",
  "lastName": "Al-Mansouri",
  "email": "newemail@example.com",
  "dob": "1980-05-15",
  "gender": "male",
  "locale": "ar",
  "countryCode": "SA"
}

→ { user: { ... } }  // updated profile
```

**Allowed fields:** firstName, lastName, email, dob, gender, locale, countryCode  
**Cannot change:** phone (unique auth key), id, createdAt

---

## Admin Endpoints

### List Users (Admin)
```
GET /users?limit=50&cursor=
Authorization: Bearer {{accessToken}}

→ {
    "data": [ { user }, { user }, ... ],
    "nextCursor": "opaque-pagination-token",
    "requestId": "req-uuid"
  }
```

**Pagination:** cursor-based (not offset). Use `nextCursor` in next request.  
**Limit:** 1–100, default 50.

---

### Get User by ID (Admin)
```
GET /users/{{userId}}
Authorization: Bearer {{accessToken}}

→ { user: { ... } }
```

---

### Update User (Admin)
```
PATCH /users/{{userId}}
Authorization: Bearer {{accessToken}}
Content-Type: application/json

{
  "firstName": "Updated",
  "status": "suspended",
  "locale": "en"
}

→ { user: { ... } }
```

---

### Delete User (Admin)
```
DELETE /users/{{userId}}
Authorization: Bearer {{accessToken}}

→ 204 No Content
```

**Soft delete:** sets `deleted_at` timestamp, preserves audit trail, does not purge data.

---

## Response Envelope (§2 — CLAUDE.md)

Every response follows the envelope format:

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "abc-123-def",
    "timestamp": "2024-08-29T12:34:56Z"
  }
}
```

**Error response:**
```json
{
  "success": false,
  "error": {
    "code": "OTP_INVALID",
    "message": "Invalid or expired OTP code",
    "details": { "attemptsRemaining": 3 }
  },
  "meta": { "requestId": "abc-123-def" }
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `VALIDATION_FAILED` | Request body schema invalid |
| `UNAUTHENTICATED` | Missing/invalid access token |
| `TOKEN_EXPIRED` | Access token expired (use refresh) |
| `FORBIDDEN` | Authenticated but no permission |
| `NOT_FOUND` | Resource not found |
| `CONFLICT` | Duplicate phone, etc. |
| `OTP_INVALID` | Wrong code or expired challenge |
| `OTP_THROTTLED` | Too many attempts, 15-min lockout |
| `RATE_LIMITED` | Too many requests |
| `INTERNAL_ERROR` | Server error |

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/auth/otp/request` | 5 | 15 min per phone |
| `/auth/otp/verify` | 5 attempts | per challengeId, then 15-min lockout |
| `/auth/refresh` | 300 | 1 min per user |
| `/users/me` (PATCH) | 60 | 1 min per user |
| Global | 300 | 1 min per user |

---

## Testing Workflow

### Test OTP Flow
```
1. POST /auth/otp/request
   → copy challengeId
2. Check SMS for OTP code (or dev logs)
3. POST /auth/otp/verify
   → tokens auto-stored
4. GET /auth/me
   → verify accessToken works
```

### Test Profile Management
```
1. GET /users/me
2. PATCH /users/me
   → update firstName, locale, etc.
3. GET /users/me
   → verify changes
```

### Test Pagination (Admin)
```
1. GET /users?limit=10
   → copy nextCursor
2. GET /users?limit=10&cursor={{nextCursor}}
   → get next page
```

---

## Developer Notes

- **Phone format:** E.164 only. +966501234567, not 0501234567 or +966 50 123 4567
- **Locale:** affects SMS language, notification copy, date formatting
- **Timestamps:** all ISO 8601 UTC with Z suffix
- **Soft deletes:** deleted_at is set, user is hidden from listings, audit preserved
- **Entitlements:** tied to Season, checked server-side for premium features
- **Phone uniqueness:** one user per phone number; no multi-device account sharing (one OTP per login)

---

## Integration Checklist

- [ ] Auth: OTP request → verify → refresh token rotation working
- [ ] Profile: GET /users/me returns all fields
- [ ] Profile: PATCH /users/me updates allowed fields only
- [ ] Admin: List users with cursor pagination
- [ ] Tokens: accessToken auto-injected on protected routes
- [ ] Rate limits: OTP throttled after 5 attempts
- [ ] Logout: refresh token becomes invalid after logout
- [ ] Errors: response envelope consistent across all endpoints
