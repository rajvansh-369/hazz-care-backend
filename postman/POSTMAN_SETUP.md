# Hazz App - Postman Collection Setup Guide

## Overview
Optimized Postman collection for Hazz App Backend API with organized endpoints, automatic token management, and environment variables.

## Import Collection

1. Open Postman
2. Click **Import** → **Upload Files** → Select `Hazz-App-API.postman_collection.json`
3. Collection loads with 4 folder groups:
   - **Health** - System health checks
   - **Auth** - Authentication & password management
   - **Users** - User CRUD & profile management
   - **Tasks** - Task CRUD & analytics

## Environment Setup

### Variables in Collection
```
baseUrl       → http://localhost:3000/v1 (default)
accessToken   → Auto-populated after login
refreshToken  → Auto-populated after login
userId        → Set manually after user query
taskId        → Set manually after task creation
```

### Configure for Different Environments

**Development:**
```
baseUrl: http://localhost:3000/v1
```

**Staging:**
```
baseUrl: https://staging.api.hazz.app/v1
```

**Production:**
```
baseUrl: https://api.hazz.app/v1
```

Edit in Postman: Click environment icon (top-right) → Manage Environments → Edit variables

## Authentication Workflow

### Setup Bearer Token
Bearer token auto-stored after login via test scripts:

1. **Register** - Create account
   ```json
   POST /auth/register
   {
     "email": "user@example.com",
     "password": "password123",
     "name": "John Doe"
   }
   ```

2. **Login** - Obtain tokens (auto-stored in `accessToken` + `refreshToken`)
   ```json
   POST /auth/login
   {
     "email": "user@example.com",
     "password": "password123"
   }
   ```

3. **Use Token** - All protected endpoints auto-inject Bearer token from `{{accessToken}}`

### Token Refresh
When access token expires:
```json
POST /auth/refresh-tokens
{
  "refreshToken": "{{refreshToken}}"
}
```
New tokens auto-stored in collection variables.

## Endpoint Organization

### Health Endpoints
- `GET /health` - Liveness probe
- `GET /health/ready` - Readiness probe

### Auth Endpoints (9 total)
- `POST /auth/register` - Create account
- `POST /auth/login` - Get tokens
- `POST /auth/refresh-tokens` - Refresh expired access token
- `GET /auth/me` - Get current user (requires token)
- `POST /auth/verify-email` - Verify email token
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password` - Reset with token
- `POST /auth/change-password` - Change password (requires token)
- `POST /auth/logout-all` - Logout all devices (requires token)

### User Endpoints (7 total)
- `GET /users/me` - Get profile (requires token)
- `PATCH /users/me` - Update profile (requires token)
- `POST /users` - Create user (requires token + users:write)
- `GET /users` - List users with pagination (requires token + users:read)
- `GET /users/:userId` - Get user by ID (requires token + users:read)
- `PATCH /users/:userId` - Update user (requires token + users:write)
- `DELETE /users/:userId` - Delete user (requires token + users:write)

### Task Endpoints (7 total)
- `GET /tasks/stats` - Get task statistics (requires token)
- `POST /tasks` - Create task (requires token)
- `GET /tasks` - List tasks with filtering/pagination (requires token)
- `GET /tasks/:taskId` - Get task by ID (requires token)
- `PATCH /tasks/:taskId` - Update task (requires token)
- `DELETE /tasks/:taskId` - Delete task (requires token)

## Features

### Automatic Token Management
- Login response extracts & stores tokens
- Refresh automatically updates both tokens
- All protected endpoints use stored token

### Pagination & Filtering
User & Task list endpoints include query params:
```
?limit=10&page=1&sortBy=createdAt:desc&status=pending
```

### Request Examples
Every endpoint includes pre-filled request bodies with realistic examples. Edit for testing.

### Variable Placeholders
Use in requests:
- `{{baseUrl}}` - API base URL
- `{{accessToken}}` - JWT access token (auto)
- `{{refreshToken}}` - JWT refresh token (auto)
- `{{userId}}` - User ID (set manually)
- `{{taskId}}` - Task ID (set manually)

## Testing Workflow

### 1. Auth Flow
```
Register → Login → Tokens stored → Ready for protected routes
```

### 2. User Operations
```
Create User → Get User → Update User → Delete User
```

### 3. Task Operations
```
Create Task → List Tasks → Get Task → Update Task → Delete Task
```

### 4. Profile Management
```
Get My Profile → Update Profile → Change Password
```

## Tips & Tricks

- **Quick Debug**: Click any endpoint → Params tab shows all query params
- **Response Preview**: After request, click Body tab to see formatted response
- **Test History**: Click History (left sidebar) to re-run previous requests
- **Collections Share**: Export with team via Postman workspace
- **Pre-request Scripts**: Modify if need custom auth (e.g., API keys)

## Rate Limiting
Auth endpoints have rate limiting. If throttled, wait before retry:
- Limit: 5 requests per 15 minutes per IP
- Header: `X-RateLimit-Limit`, `X-RateLimit-Remaining`

## Error Handling

Common response codes:
- `200` - Success
- `201` - Created
- `400` - Bad request (check body schema)
- `401` - Unauthorized (refresh token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found
- `429` - Rate limited (wait and retry)
- `500` - Server error

## Notes

- All timestamps in ISO 8601 format
- Passwords must be 8+ characters
- Email uniqueness enforced
- Task ownership enforced (can only manage own tasks)
- User roles: `user`, `admin`
