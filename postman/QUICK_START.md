# HajjCare API - Quick Postman Setup

## Server Running?

```bash
# Check if server is running on port 3000
curl http://localhost:3000/api/v1/health

# Should return:
# { "success": true, "data": { "status": "up" } }
```

## Postman Setup - 3 Steps

### 1. Import Collection
```
File → Import → Upload Files
→ Select: HajjCare-API.postman_collection.json
```

### 2. Verify Base URL
Click gear icon (top-right) → Manage Environments → Collection Variables

**Must match your server:**
```
baseUrl = http://localhost:3000/api/v1
```

If server runs on different port:
```
baseUrl = http://localhost:YOUR_PORT/api/v1
```

### 3. Test Health Endpoint First
```
GET http://localhost:3000/api/v1/health
```

Expected response (200 OK):
```json
{
  "success": true,
  "message": "Service is live",
  "data": {
    "status": "up",
    "service": "core-service"
  }
}
```

---

## API Endpoints (Current)

### Health (No auth needed)
```
GET /health              → liveness probe
GET /health/ready        → readiness probe
```

### Auth - Email/Password (Traditional)
```
POST /auth/register      → { name, email, password } → user + tokens
POST /auth/login         → { email, password } → user + tokens
POST /auth/refresh-tokens → { refreshToken } → new tokens
POST /auth/logout-all    → logout all devices
POST /auth/verify-email  → { token } → verify email
POST /auth/forgot-password → { email } → send reset link
POST /auth/reset-password → { token, password } → reset password
POST /auth/change-password → { currentPassword, newPassword } → change password
```

### Auth - OTP Flow (Phone-first)
```
POST /auth/otp/request   → { phone, locale } → { challengeId, expiresIn }
POST /auth/otp/verify    → { challengeId, code } → { accessToken, refreshToken, isNewUser }
POST /auth/refresh       → { refreshToken } → rotated tokens
POST /auth/logout        → { refreshToken } → revoke session
```

### Auth - Device & Me (Requires Bearer token)
```
POST /auth/devices       → { pushToken, platform, appVersion, locale }
GET  /auth/me            → user + journey + entitlement
```

### Users - Self Profile (Requires Bearer token)
```
GET  /users/me           → get profile
PATCH /users/me          → update firstName, lastName, email, dob, gender, locale, countryCode
```

### Users - Admin (Requires Bearer token)
```
GET  /users              → list users with cursor pagination
GET  /users/:userId      → get user by ID
PATCH /users/:userId     → update user
DELETE /users/:userId    → delete user
```

---

## Common Issues & Fixes

### ❌ "Cannot GET /api/v1/auth/otp/request"
**Fix:** Check baseUrl in Postman
- Click gear icon → Collection Variables
- Verify `baseUrl = http://localhost:3000/api/v1`
- NOT `http://localhost:3000/v1` (missing `/api`)

### ❌ "404 Not Found" on any endpoint
**Fix:** Verify full URL
```
Correct:   http://localhost:3000/api/v1/auth/otp/request
Wrong:     http://localhost:3000/auth/otp/request  (missing /api/v1)
```

### ❌ Server not responding
**Fix:** Start server
```bash
cd D:/GIT/hazz-app/backend/backend-api
PORT=3000 npm start
```

### ❌ "Port 3000 already in use"
**Fix:** Use different port
```bash
PORT=3001 npm start
# Then update Postman baseUrl to http://localhost:3001/api/v1
```

---

## Test Workflow

### 1. Health Check
```
GET /health
→ Should return 200 OK
```

### 2. Request OTP
```
POST /auth/otp/request
Body: { "phone": "+966501234567", "locale": "ar" }
→ Returns: { "challengeId": "...", "expiresIn": 300 }
```

### 3. Verify OTP (Stub Implementation)
```
POST /auth/otp/verify
Body: { "challengeId": "...", "code": "123456" }
→ Currently: Returns stub tokens (full DB integration pending)
```

### 4. Get Me
```
GET /auth/me
Auth: Bearer {{accessToken}}
→ Returns: user + journey + entitlement
```

### 5. Get My Profile
```
GET /users/me
Auth: Bearer {{accessToken}}
→ Returns: user profile
```

---

## Notes

- **Base URL format:** `http://localhost:PORT/api/v1` (NOT `/v1` alone)
- **Auth:** Bearer token in Authorization header (auto-injected in Postman)
- **Phone format:** E.164 only: +966501234567
- **OTP code:** 6 digits (stub accepts any code for now)
- **Tokens:** Auto-stored in collection variables after login

---

## Server Logs

Check `D:/GIT/hazz-app/backend/backend-api/server.log` for errors.

Or run:
```bash
cd D:/GIT/hazz-app/backend/backend-api
PORT=3000 npm start
```

To see live output.
