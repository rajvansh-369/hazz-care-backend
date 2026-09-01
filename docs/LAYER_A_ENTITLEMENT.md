# Entitlement Model — Layer A Contract (Lifetime Pass)

## Overview
Records which pilgrims have a valid lifetime pass. **Client queries its own local database for access gates; server keeps this record for support and refunds only.** (CLAUDE.md §A5)

## Contract Summary (§A5, §A8)

| Aspect | Layer A | Previous PRS |
|--------|---------|-------------|
| Pass Type | **Lifetime, non-consumable** | Season-scoped, renewed annually |
| Expiry | None — never expires | Explicit `expires_at` field |
| Server Role | Support inquiry + refund destination | Client access gate (❌ wrong) |
| Client Role | Local DB gate (exclusive source of truth) | Asks server for status (❌ risky offline) |
| Revocation | Only via `CANCELLATION` + `CUSTOMER_SUPPORT` | Automatic on expiry |

## Required Fields (§A8)

| Field | Type | Purpose |
|-------|------|---------|
| `user` | ObjectId ref | Unique ref to User (one pass per pilgrim) |
| `productId` | String | Which product was purchased (e.g., `com.example.hajjcare.lifetime_pass`) |
| `grantedAt` | Date | When pass was purchased (audit trail) |
| `revokedAt` | Date (optional) | When pass was refunded/cancelled (null = active) |
| `createdAt`, `updatedAt` | Date | Timestamps |

## Why NO expiresAt Field (§A5, §A8)

**Forbidden explicitly.** Reasons:

1. **Lifetime pass never expires.** RevenueCat defines product as non-renewing. No expiry date exists.
2. **If added, pilgrims disappear after expiry date.** Even if code never checked it, data existence invites bugs.
3. **Expiration logic must NOT touch this model.** No cron jobs, no cleanup, no sweep.
4. **Client offline 45 days during Hajj.** Server expiry wouldn't gate access anyway (client decides).

If someone refunded and wants it back: delete this row and create a new grant.

## The Unique Constraint: One Pass Per User

```javascript
user: {
  type: mongoose.SchemaTypes.ObjectId,
  ref: 'User',
  required: true,
  unique: true,  // <-- Only one Entitlement per user
}
```

**If a user tries to re-purchase:** Database insert fails with E11000 (duplicate key). Service must handle:

```javascript
try {
  await Entitlement.create({ user: userId, productId, grantedAt });
} catch (error) {
  if (error.code === 11000) {
    // User already has a pass; update instead
    await Entitlement.updateOne(
      { user: userId },
      { 
        grantedAt: new Date(),  // Update purchase date
        revokedAt: null,         // Un-revoke if was refunded
      }
    );
    return;
  }
  throw error;
}
```

## Grant Entitlement: INITIAL_PURCHASE & NON_RENEWING_PURCHASE

RevenueCat sends webhook → service creates or updates Entitlement.

```javascript
// RevenueCatEvent handler (Phase 4 BullMQ processor)
if (event.type === 'INITIAL_PURCHASE' || event.type === 'NON_RENEWING_PURCHASE') {
  const user = await User.findById(event.app_user_id);
  
  const entitlement = await Entitlement.findOneAndUpdate(
    { user: user._id },
    {
      user: user._id,
      productId: event.product_id,
      grantedAt: new Date(event.purchase_date_ms),
      revokedAt: null,  // Active pass
    },
    { upsert: true, new: true }
  );
  
  // Support/compliance: log grant
  logger.info(`Entitlement granted to ${user.email}`, {
    productId: entitlement.productId,
    grantedAt: entitlement.grantedAt,
  });
}
```

## Revoke Entitlement: CANCELLATION + cancel_reason: CUSTOMER_SUPPORT

Only reason that revokes. Others (UNSUBSCRIBE, BILLING_ISSUE, PRODUCT_CHANGE) ignore.

```javascript
if (event.type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT') {
  const entitlement = await Entitlement.findOneAndUpdate(
    { user: event.app_user_id },
    { revokedAt: new Date() },
    { new: true }
  );
  
  if (entitlement) {
    logger.warn(`Entitlement revoked (customer support)`, {
      userId: event.app_user_id,
      revokedAt: entitlement.revokedAt,
    });
  }
}
```

## Transfer Entitlement: TRANSFER Event

Move pass from one user to another (e.g., account recovery).

```javascript
if (event.type === 'TRANSFER') {
  const fromUser = event.transferred_from; // old user.id
  const toUser = event.transferred_to;     // new user.id
  
  // 1. Revoke old user's pass
  await Entitlement.updateOne(
    { user: fromUser },
    { revokedAt: new Date() }
  );
  
  // 2. Grant to new user (upsert in case they already have one)
  await Entitlement.findOneAndUpdate(
    { user: toUser },
    {
      user: toUser,
      productId: event.product_id,
      grantedAt: new Date(),
      revokedAt: null,
    },
    { upsert: true }
  );
}
```

## EXPIRATION Event: Log & Ignore

RevenueCat should never send this (lifetime pass). If it does: log alert, do nothing.

```javascript
if (event.type === 'EXPIRATION') {
  logger.alert(`Unexpected EXPIRATION event for lifetime pass`, {
    eventId: event.id,
    userId: event.app_user_id,
    expiration_at_ms: event.expiration_at_ms, // Always null
  });
  // Do NOT update Entitlement; do NOT delete
}
```

## Client-Side Access Gate (NOT Server)

Server has no `/subscription/entitlement` or similar endpoint.

Client checks its local SQLite database:

```javascript
// Pseudocode: client-side, in Flutter
const pass = await localDb.entitlements.where('userId = $userId').first();
if (pass != null && pass.revokedAt == null) {
  // Has active pass; unlock premium features
} else {
  // No pass or revoked; show paywall
}
```

**Why server doesn't gate:**
1. Offline 45 days during Hajj — network unavailable.
2. Medication alarms, emergency contacts, health data are local-first.
3. Paywall is a business feature; doesn't block critical health data.

## Support Queries (Why We Store This)

Support team needs to answer: "Did [email] pay?"

```javascript
// Support CLI or dashboard (Phase 4+)
const user = await User.findOne({ email });
const ent = await Entitlement.findOne({ user: user._id });

if (ent && !ent.revokedAt) {
  console.log(`${user.email} has active lifetime pass (since ${ent.grantedAt})`);
} else if (ent && ent.revokedAt) {
  console.log(`${user.email} had pass but refunded (${ent.revokedAt})`);
} else {
  console.log(`${user.email} never purchased`);
}
```

## Refund Destination

When customer requests refund through RevenueCat:

1. RevenueCat sends `CANCELLATION` webhook
2. Service marks `revokedAt = now`
3. Support sees revocation; processes refund (external to this system)
4. If customer disputes or re-purchases: webhook updates `revokedAt = null`

Entire state is in this table and `RevenueCatEvent` audit trail.

## Query Patterns for Phase 4

### Check if user has active pass
```javascript
const hasPass = async (userId) => {
  const ent = await Entitlement.findOne({
    user: userId,
    revokedAt: null,  // Active
  });
  return !!ent;
};
```

### Find by user
```javascript
const ent = await Entitlement.findOne({ user: userId });
if (ent) {
  console.log(`Pass granted: ${ent.grantedAt}`);
  if (ent.revokedAt) console.log(`Revoked: ${ent.revokedAt}`);
}
```

### Support audit: recent grants/revocations
```javascript
const recent = await Entitlement.find({
  $or: [
    { grantedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    { revokedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  ],
}).populate('user', 'email');
```

### Transfer: find all entitlements for user (should be 0-1)
```javascript
// Sanity check: verify uniqueness (should never find 2)
const ents = await Entitlement.find({ user: userId });
if (ents.length > 1) {
  logger.alert(`Multiple entitlements for user ${userId}!`);
}
```

## Schema Design: What NOT to Add

❌ `expiresAt` — forbidden (lifetime pass)  
❌ `seasonCode`, `season` — lifetime, not seasonal  
❌ `features: []` — static; never changes (defined in app or config)  
❌ `source` (apple/google/stripe/tap) — RevenueCat abstracts; in raw event only  
❌ `gracePeriod`, `trialEnds` — not applicable  
❌ `autoRenewal` — non-renewing product only  

## Test Coverage

See `tests/models/entitlement.model.test.js` for:
- Unique user constraint (one pass per pilgrim)
- No expiresAt field (forbidden)
- Grant/revoke patterns
- Transfer (move between users)
- EXPIRATION ignore
- Query patterns for support + client integration
- RevenueCat event → Entitlement mapping
