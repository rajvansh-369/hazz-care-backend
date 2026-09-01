# RevenueCatEvent Model — Layer A Webhook Contract

## Overview
Stores RevenueCat purchase webhooks for idempotent event processing per §A8. **Uses `event.id` as primary key** for duplicate detection on retries.

## Fields (§A8)

| Field | Type | Purpose |
|-------|------|---------|
| `_id` | String | RevenueCat `event.id` (primary key). Same event retried → same `_id` → duplicate detected by E11000 |
| `type` | String | RevenueCat event type (INITIAL_PURCHASE, NON_RENEWING_PURCHASE, TRANSFER, CANCELLATION, etc.) |
| `appUserId` | String | Our `user.id` (indexed for audit queries). Identifies pilgrim in our system |
| `raw` | Mixed | Complete webhook payload (audit trail; unchanged from RevenueCat) |
| `receivedAt` | Date | When webhook landed (default: now) |
| `createdAt`, `updatedAt` | Date | Timestamps |

## Webhook Auth (§A8)

No signature scheme. Use constant-time header compare:

```javascript
const crypto = require('crypto');

const RC_WEBHOOK_SECRET = process.env.RC_WEBHOOK_SECRET; // min 32 chars, env var

router.post('/webhooks/revenuecat', (req, res, next) => {
  const headerAuth = req.headers['authorization']; // RevenueCat sends this
  
  // Constant-time compare (not ===)
  const expected = RC_WEBHOOK_SECRET;
  if (!crypto.timingSafeEqual(Buffer.from(headerAuth), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Never log headerAuth or RC_WEBHOOK_SECRET
  next();
});
```

## Idempotency via Unique _id (§A8)

RevenueCat retries webhooks for ~72 hours. Duplicates are normal.

```javascript
// Handler must be idempotent: same event.id → no duplicate work

try {
  await RevenueCatEvent.create({
    _id: event.id, // e.g., 'rc_evt_12345'
    type: event.type,
    appUserId: event.app_user_id,
    raw: event,
    receivedAt: new Date(),
  });
} catch (error) {
  if (error.code === 11000) {
    // Duplicate: event already processed
    return res.status(200).json({ success: true });
  }
  throw error;
}
```

## Webhook Handling Pattern (§A8)

```
1. Persist raw event immediately (atomic, no processing)
2. Return 200 OK to RevenueCat fast
3. Enqueue processing on BullMQ (async)
4. Service consumes queue, handles events
```

**Why:** Network timeouts or crashes don't lose events. RetryCount stays manageable.

## Event Types (§A8)

| Type | Action | Notes |
|------|--------|-------|
| `INITIAL_PURCHASE` | Grant entitlement | New purchase on app store |
| `NON_RENEWING_PURCHASE` | Grant entitlement | Lifetime pass (non-renewing) |
| `TRANSFER` | Move entitlement | User transferred between accounts |
| `CANCELLATION` | Revoke (if reason: CUSTOMER_SUPPORT) | Refund or user request |
| `EXPIRATION` | Log alert, **change nothing** | Should never arrive for lifetime pass |
| `SUBSCRIPTION_*`, `BILLING_ISSUE`, `PRODUCT_CHANGE` | Ignore | Not applicable to Layer A |

### Event Details

#### INITIAL_PURCHASE & NON_RENEWING_PURCHASE
```javascript
{
  app_user_id: "user123",           // Our user.id
  product_id: "com.example.app...", // RevenueCat product ID
  purchase_id: "...",               // Store transaction ID
  purchase_date_ms: 1234567890,
  // ... other fields
}
```
**Action:** Create Entitlement with user=app_user_id, productId, grantedAt=now

#### TRANSFER
```javascript
{
  app_user_id: "user_new",           // New owner (to)
  transferred_from: "user_old",      // Old owner (from)
  transferred_to: "user_new",        // Confirmation
  // ...
}
```
**Action:** 
1. Find old Entitlement by user=transferred_from
2. If found, mark revokedAt=now
3. Create new Entitlement for transferred_to

#### CANCELLATION
```javascript
{
  app_user_id: "user123",
  cancel_reason: "CUSTOMER_SUPPORT", // Only revoking reason
  // Ignore: "UNSUBSCRIBE", "BILLING_ISSUE", "PRODUCT_CHANGE"
  // ...
}
```
**Action (only if reason === "CUSTOMER_SUPPORT"):** Mark Entitlement revokedAt=now

#### EXPIRATION
```javascript
{
  app_user_id: "user123",
  expiration_at_ms: null, // Always null (lifetime pass)
  // ...
}
```
**Action:** Log alert; do NOT create/update/revoke anything. Lifetime pass never expires.

## Sandbox Filtering (§A8)

RevenueCat sends both production and sandbox events (for testing).

```javascript
// In production deployment:
if (event.environment === 'SANDBOX') {
  // Log and ignore; process only PRODUCTION
  logger.debug(`Ignored sandbox event ${event.id}`);
  return res.status(200).json({ success: true });
}
```

## Anonymous User Detection (§A8)

RevenueCat may send events for users who haven't logged in (bug in client integration).

```javascript
// Check for RevenueCat's placeholder
if (event.app_user_id.startsWith('$RCAnonymousID:')) {
  // Client bug: user never authenticated with us
  logger.alert(`Anonymous purchase attempted: ${event.id}`);
  // Do NOT create user, do NOT grant entitlement
  return res.status(400).json({ error: 'Invalid user' });
}
```

## expiration_at_ms: Always Null (§A8)

Lifetime pass never expires.

```javascript
// This is ALWAYS null in RevenueCat events for lifetime products
// Never create expiresAt field on Entitlement
// Never check expiration server-side; client owns that

if (event.expiration_at_ms !== null) {
  // Sanity check: log alert
  logger.warn(`Non-null expiration on lifetime pass? Event ${event.id}`);
}
```

## Query Patterns for Phase 4

### Find recent events for audit
```javascript
const recentEvents = await RevenueCatEvent.find({
  createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
});
```

### Find events for a user
```javascript
const userEvents = await RevenueCatEvent.find({
  appUserId: userId,
});
```

### Check if event already processed
```javascript
const existing = await RevenueCatEvent.findById(event.id);
if (existing) {
  // Already processed; skip
  return;
}
```

## Service Layer: BullMQ Queue

Pattern (Phase 4):

```javascript
// Webhook handler: persist and enqueue
router.post('/webhooks/revenuecat', async (req, res) => {
  try {
    await RevenueCatEvent.create({ _id: event.id, ... });
  } catch (e) {
    if (e.code === 11000) return res.status(200).json({}); // Already done
    throw;
  }
  
  // Enqueue for processing
  await processingQueue.add('process-rc-event', { eventId: event.id });
  
  res.status(200).json({ success: true });
});

// Queue processor
processingQueue.process('process-rc-event', async (job) => {
  const rcEvent = await RevenueCatEvent.findById(job.data.eventId);
  const event = rcEvent.raw;
  
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'NON_RENEWING_PURCHASE':
      await entitlementService.grant(event.app_user_id, event.product_id);
      break;
    case 'TRANSFER':
      await entitlementService.transfer(event.transferred_from, event.transferred_to);
      break;
    case 'CANCELLATION':
      if (event.cancel_reason === 'CUSTOMER_SUPPORT') {
        await entitlementService.revoke(event.app_user_id);
      }
      break;
    // ... etc
  }
});
```

## Security

- **Never log webhook secret** — it's the only auth.
- **Never log raw event** if it contains sensitive purchase data (but logging raw is OK for audit after redaction).
- **Constant-time auth compare** — not `===` or `.toString() ===`.
- **Idempotency prevents duplicates** — critical when webhook is retried during crash.

## Test Coverage

See `tests/models/revenueCatEvent.model.test.js` for:
- Unique _id enforcement (idempotency)
- Event type handling patterns
- Sandbox filtering
- Anonymous user detection
- expiration_at_ms always null verification
- Query patterns for audit and processing
