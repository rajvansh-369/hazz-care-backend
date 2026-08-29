# CLAUDE.md — HajjCare Backend API

> **Product:** HajjCare — *Your Health. Your Hajj. Your Peace of Mind.*
> **This repo:** the Node.js REST + realtime API that powers the HajjCare mobile app.
> **Spec version implemented:** PRS v2.0 (Merged Full-Feature Specification)
> **Monetization:** one-off, season-scoped pass (`HajjCare Pass`). No recurring billing anywhere in this codebase.

This file is the contract for anyone (human or Claude) writing code here. Read the section that covers your task before you touch files. If something in this file conflicts with code you find, the file wins — fix the code or raise it.

---

## 1. What this backend is responsible for

The app is **offline-first**. Pilgrims lose connectivity in Mina, Arafat, and Muzdalifah for hours at a time, and often carry a foreign SIM with no data. The backend is therefore:

- the **source of truth** for identity, entitlements, family groups, and consent;
- a **sync target** for data the phone captures offline (vitals, pill logs, step counts, ritual progress);
- a **fan-out engine** for SOS broadcasts, family location, and heat alerts;
- a **content delivery service** for offline packs (maps, ritual guides, translations).

The backend is *not* responsible for: rendering UI, deciding notification copy at display time (client owns local notification scheduling), or being on the critical path of an SOS. **An SOS must work with the last-known cached contact list even if this API is down.** Design accordingly.

### Non-negotiable properties

| Property | Rule |
|---|---|
| Offline tolerance | Every write endpoint accepts client-generated UUIDs and is idempotent. |
| PHI safety | Medical fields are encrypted at rest and never logged. |
| Consent-gated reads | No health/location data leaves the API without an active `SharingGrant`. |
| Entitlement-gated features | Premium routes check a season pass, never a subscription status. |
| Auditability | Every read of another user's health data writes an `AuditLog` row. |

---

## 2. Stack & conventions

```
Runtime      Node.js 20 LTS (ESM, "type": "module")
Language     TypeScript, strict: true
Framework    Express 4 (thin) — all logic in services, not routes
DB           PostgreSQL 15 + Prisma ORM
Cache/Queue  Redis 7 + BullMQ
Realtime     Socket.IO (family tracking, SOS), namespaced /rt
Validation   Zod (schema per endpoint, shared with response typing)
Auth         JWT access (15m) + rotating refresh (30d), OTP for phone
Logging      Pino (JSON, redaction list — see §11)
Push         Firebase Cloud Messaging (Android + iOS via APNs bridge)
Testing      Vitest + Supertest, Testcontainers for Postgres/Redis
Docs         OpenAPI 3.1 generated from Zod via zod-to-openapi at /docs
```

If the existing project already uses a different choice (e.g. Fastify or Mongoose), **do not migrate it** — adapt the guidance here to what is there and note the deviation in this file.

### Layering rule

```
routes/      HTTP only: parse, validate, call service, shape response. No DB, no business rules.
services/    All business logic. Pure-ish, takes a ctx (userId, locale, tx). Throws AppError.
repositories/ Prisma access. One file per aggregate. No business rules.
jobs/        BullMQ processors. Thin wrappers over services.
lib/         Crypto, heat math, geo, i18n, receipt verification.
```

A route handler longer than ~15 lines is a smell — push it into a service.

### Directory layout

```
src/
  app.ts                 express wiring, middleware order
  server.ts              http + socket.io bootstrap
  config/                env schema (zod), constants, feature flags
  middleware/            auth, entitlement, rateLimit, requestId, errorHandler, audit
  routes/v1/
    auth.routes.ts
    profile.routes.ts
    subscription.routes.ts
    health.routes.ts
    passport.routes.ts
    sharing.routes.ts
    vitals.routes.ts
    activity.routes.ts
    environment.routes.ts
    medicines.routes.ts
    hajj.routes.ts
    family.routes.ts
    emergency.routes.ts
    sync.routes.ts
    content.routes.ts
    webhooks.routes.ts
  services/
  repositories/
  jobs/
    medicationReminder.job.ts
    heatWatch.job.ts
    passportCompleteness.job.ts
    entitlementExpiry.job.ts
    sosEscalation.job.ts
  lib/
    crypto/fieldCipher.ts
    heat/heatIndex.ts
    geo/haversine.ts, geofence.ts
    i18n/
    payments/{apple,google,stripe,tap}.ts
  realtime/
  types/
prisma/schema.prisma
tests/
```

### API conventions

- Base path `/api/v1`. Breaking changes get `/api/v2`; never mutate v1 shapes.
- `snake_case` in the database, `camelCase` in JSON.
- All timestamps ISO-8601 **UTC** with `Z`. Client sends its IANA zone in `X-Timezone`; medication schedules and ritual days are computed in *Asia/Riyadh* during the journey and in the user's home zone before departure.
- Every request carries `X-Request-Id` (generated if absent) and `Accept-Language`.
- Pagination: cursor-based. `?cursor=<opaque>&limit=50`, response `{ data, nextCursor }`.

**Response envelope — use everywhere:**

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…" } }

// error
{ "success": false,
  "error": { "code": "ENTITLEMENT_REQUIRED",
             "message": "A HajjCare Pass is required for this feature.",
             "details": { "feature": "offline_maps" } },
  "meta": { "requestId": "…" } }
```

`message` is localized via `Accept-Language`; `code` is stable and machine-readable. The client maps `code` → its own copy, so **never let the client parse `message`**.

### Error codes (extend, don't invent ad hoc)

`VALIDATION_FAILED`, `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `ENTITLEMENT_REQUIRED`, `ENTITLEMENT_EXPIRED`, `CONSENT_REQUIRED`, `CONSENT_REVOKED`, `OTP_INVALID`, `OTP_THROTTLED`, `RECEIPT_INVALID`, `RECEIPT_ALREADY_CLAIMED`, `PAYMENT_FAILED`, `SYNC_CONFLICT`, `RATE_LIMITED`, `DEPENDENT_CONSENT_REQUIRED`, `INTERNAL_ERROR`.

---

## 3. Data model

Prisma is the single source of truth; this is the intent behind it. Every table has `id` (UUID v7), `created_at`, `updated_at`. Sync-eligible tables also carry `client_id` (UUID from device), `version` (int), `deleted_at` (soft delete), `synced_at`.

### Identity & journey

- **User** — `phone` (E.164, unique), `email`, `first_name`, `last_name`, `dob`, `country_code`, `locale` (`en|ar|ur|id|fr|bn|tr`), `gender`, `status`, `push_tokens[]`, `last_known_location` (PostGIS `geography(Point)`), `last_seen_at`.
- **Journey** — `user_id`, `type` (`HAJJ|UMRAH|BOTH`), `season_id`, `departure_date`, `return_date`, `operator_name`, `group_code`. Drives the "63 days until Hajj" countdown; countdown is computed server-side and returned as `daysUntilDeparture` so the client never disagrees with the reminder engine.
- **Season** — `code` (e.g. `hajj-1447`), `hijri_year`, `starts_at`, `ends_at`, `pass_price_usd`, `pass_price_sar`. **Entitlements are scoped to a Season row, not to a date range hard-coded in code.**
- **EmergencyContact** — `user_id`, `name`, `relationship`, `phone`, `whatsapp_number`, `is_primary`, `notify_order`, `locale`. Max 5 per user.

### Entitlement & payments

- **Entitlement** — `user_id`, `season_id`, `product_id`, `source` (`APPLE|GOOGLE|STRIPE|TAP|PROMO|OPERATOR_BULK`), `status` (`ACTIVE|REFUNDED|REVOKED`), `granted_at`, `expires_at` (= `season.ends_at + 30d` grace), `original_transaction_id`. Unique on `(user_id, season_id)`.
- **PaymentTransaction** — raw provider payload (JSONB), `amount_minor`, `currency`, `provider_txn_id` (unique), `state`, `idempotency_key`, `raw_receipt` (encrypted). Append-only; never update in place, insert a new state row.

### Health

- **HealthProfile** — 1:1 with User. `blood_type`, `height_cm`, `weight_kg`, and encrypted JSONB `clinical_notes`.
- **HealthCondition** — `name`, `icd10_code?`, `severity`, `diagnosed_at`, `notes` *(encrypted)*.
- **Allergy** — `allergen`, `type` (`DRUG|FOOD|ENVIRONMENTAL`), `reaction`, `severity` (`MILD|MODERATE|SEVERE|ANAPHYLAXIS`).
- **Vaccination** — `vaccine` (`MENINGOCOCCAL_ACWY|COVID_19|YELLOW_FEVER|POLIO|INFLUENZA|OTHER`), `dose_number`, `administered_on`, `expires_on`, `certificate_url`, `verified`. Meningococcal ACWY is a Saudi entry requirement — surface `expires_on` in readiness scoring.
- **VitalReading** — `type` (`BP|GLUCOSE|SPO2|HEART_RATE|TEMPERATURE|WEIGHT`), `value_numeric`, `value_secondary` (diastolic), `unit`, `measured_at`, `source` (`MANUAL|WEARABLE|DEVICE`). High-volume: partition by month.
- **ActivityDay** — one row per user per local date: `steps`, `distance_m`, `active_minutes`, `floors`, `sleep_minutes`, `sleep_quality`, `resting_hr`, `strain_score`. Upsert on `(user_id, local_date)`.
- **HealthPassport** — `completion_pct`, per-section status JSONB, `share_token`, `token_expires_at`, `pdf_url`, `last_generated_at`.

### Consent & sharing

- **SharingGrant** — `owner_id`, `recipient_type` (`FAMILY|CLINICIAN|OPERATOR|EMERGENCY`), `recipient_user_id?`, `recipient_ref?` (operator/clinic id), `scopes` (bitmask or string[]: `HEALTH_STATUS`, `FULL_MEDICAL`, `LIVE_LOCATION`, `MEDICATION_LIST`), `expires_at`, `revoked_at`, `created_via`.
- **ConsentEvent** — immutable log of grant/revoke with actor, IP, user-agent. Required for PDPL/GDPR evidence.
- **AuditLog** — `actor_id`, `subject_id`, `resource`, `action`, `grant_id`, `ip`, `at`. Write on **every** cross-user read.

### Medicines

- **Medicine** — `name`, `generic_name`, `form`, `strength`, `route`, `purpose`, `prescriber`, `is_critical` (must-not-miss), `requires_refrigeration`, `quantity_on_hand`, `travel_checklist_state`.
- **MedicationSchedule** — `medicine_id`, `frequency` (`DAILY|INTERVAL|WEEKLY|PRN`), `times[]` (local HH:mm), `interval_hours`, `days_of_week[]`, `with_food`, `starts_on`, `ends_on`, `ritual_pause` (skip during Ihram-restricted windows if clinician-flagged).
- **MedicationDose** — materialized dose instances: `scheduled_at`, `status` (`PENDING|TAKEN|SKIPPED|MISSED`), `taken_at`, `logged_offline`. Generated 14 days ahead by a job so the phone can hold them offline.
- **PharmacistInquiry** — `question`, `medicine_ids[]`, `status`, `answer`, `answered_by`, `answered_at`. **This is a human-in-the-loop queue. Never auto-answer a drug question from a model.**

### Hajj / logistics

- **RitualProgress** — `ritual` (`IHRAM|TAWAF_QUDUM|SAI|MINA_D8|ARAFAT|MUZDALIFAH|RAMY_D10|HALQ|TAWAF_IFADAH|RAMY_D11|RAMY_D12|TAWAF_WADA`), `status`, `completed_at`, `notes`.
- **Trip** — flights (`pnr`, `carrier`, `flight_no`, `depart_at`, `arrive_at`), hotel, visa/permit refs.
- **LocationPin** — `type` (`TENT|CAMP|HOTEL|BUS_STOP|CLINIC|GATE|MEETING_POINT`), `label`, `point` (geography), `mina_zone`, `tent_number`, `photo_url`, `notes`. The tent pin is the single most-used offline feature — keep it tiny and cacheable.
- **OfflinePack** — versioned content bundle: `kind` (`MAP_TILES|RITUAL_GUIDE|PHRASEBOOK|EMERGENCY_INFO`), `locale`, `version`, `size_bytes`, `checksum`, `url`, `min_app_version`.

### Family & emergency

- **FamilyGroup** — `name`, `owner_id`, `invite_code` (short, rotating), `type` (`FAMILY|TOUR_GROUP`).
- **FamilyMember** — `group_id`, `user_id`, `role` (`OWNER|GUARDIAN|MEMBER|DEPENDENT`), `share_scopes`, `is_dependent`, `guardian_id`.
- **SosEvent** — `user_id`, `triggered_at`, `location`, `accuracy_m`, `battery_pct`, `status` (`ACTIVE|ACKNOWLEDGED|RESOLVED|FALSE_ALARM`), `resolved_by`, `notified[]`, `escalation_stage`, `context` (last vitals + heat index + medical summary snapshot).
- **EnvironmentReading** — cached weather per H3 cell: `temp_c`, `humidity_pct`, `heat_index_c`, `wbgt_estimate`, `uv_index`, `risk_tier`, `fetched_at`, `ttl`.
- **AlertDelivery** — dedupe/delivery ledger for every push so the same heat alert is never sent twice.

---

## 4. Auth

Phone-first, because many pilgrims have no reliable email.

```
POST /auth/otp/request      { phone, locale }        → { challengeId, expiresIn }
POST /auth/otp/verify       { challengeId, code }    → { accessToken, refreshToken, isNewUser }
POST /auth/refresh          { refreshToken }         → rotated pair
POST /auth/logout           { refreshToken }         → revokes device session
GET  /auth/me                                        → user + journey + entitlement summary
POST /auth/devices          { pushToken, platform, appVersion, locale }
```

Rules:
- OTP: 6 digits, 5-minute TTL, max 5 attempts, then 15-minute lockout keyed on `phone` **and** IP. Store only a hash of the code.
- Refresh tokens are rotating and single-use; reuse detection revokes the whole device family and logs a security event.
- Access token claims: `sub`, `sid` (session), `locale`, `ent` (boolean entitlement hint — a hint only, always re-check server-side).
- Never return a different error for "unknown phone" vs "known phone". Enumeration protection matters here; pilgrim phone lists get traded.

---

## 5. Subscription — one-off pass (read this before touching billing)

**There are no plans, no renewals, no `cancel_at_period_end`, no proration.** If you find yourself writing any of that, you have misread the product. The user buys once, gets everything for that season.

### Product model

| Field | Value |
|---|---|
| Product ID | `hajjcare_pass_<season_code>` e.g. `hajjcare_pass_hajj_1447` |
| Price | $14.99 USD / 50 SAR (source of truth: `Season` row, not code) |
| Type | Non-consumable (Apple) / one-time product (Google) / one-time PaymentIntent (Stripe, Tap) |
| Grants | All features listed in §5.2 for `season.starts_at … season.ends_at + 30d grace` |

### 5.1 Endpoints

```
GET  /subscription/products            → active season, price by currency, feature list (localized)
POST /subscription/verify/apple        { transactionJws }        → entitlement
POST /subscription/verify/google       { purchaseToken, productId } → entitlement
POST /subscription/checkout            { provider, currency }    → { checkoutUrl | clientSecret }
GET  /subscription/entitlement         → { active, seasonCode, expiresAt, source, features[] }
POST /subscription/restore             → re-verifies store receipts for this account
POST /webhooks/apple  |  /webhooks/google  |  /webhooks/stripe  |  /webhooks/tap
```

### 5.2 Entitlement-gated features

`offline_maps`, `heat_alerts`, `activity_tracking`, `sleep_tracking`, `passport_share`, `passport_pdf`, `offline_ritual_guides`, `family_tracking`, `pharmacist_inquiry`, `data_export`.

**Always free, never gated — safety floor:** SOS broadcast, emergency contact storage and dialing, current medication list read, allergy list read, basic profile. A pilgrim in distress must never hit a paywall. Enforce this in `entitlement.middleware.ts` with an explicit allowlist, not by remembering to skip the middleware.

### 5.3 Verification rules

- Apple: verify the **signed JWS transaction** against Apple's root certs (App Store Server API), check `bundleId`, `productId`, `environment`. Handle `REFUND` and `REVOKE` notifications → set entitlement `REFUNDED` and revoke.
- Google: `purchases.products.get`, require `purchaseState == 0`, then **acknowledge within 72 hours** or Google auto-refunds. Acknowledgement is a job with retries, not a best-effort inline call.
- A `original_transaction_id` / `purchaseToken` may be claimed by exactly one user. Second claim → `RECEIPT_ALREADY_CLAIMED`. This is the main fraud vector; the check is a unique DB constraint, not an `if`.
- Webhooks: verify signature, then enqueue. Processing is idempotent on `provider_txn_id`. Return 200 fast; never do verification work inside the HTTP handler.
- Operator bulk purchase (`OPERATOR_BULK`): an agency buys N seats, receives redemption codes, each code grants one entitlement. Codes are single-use, hashed at rest.

---

## 6. Health endpoints

```
GET   PUT   /health/profile
CRUD        /health/conditions        /health/allergies        /health/vaccinations
POST  GET   /health/vitals            ?type=&from=&to=&cursor=
POST        /health/vitals/batch      offline flush, ≤500 readings
GET         /health/vitals/summary    latest per type + 7/30-day trend + out-of-range flags
PUT   GET   /health/activity/:date    steps, sleep, strain
GET         /health/activity/summary  ?range=7d|30d
GET         /health/readiness         HajjReady score, see below
```

### HajjReady score

Computed server-side (`readiness.service.ts`) so the number is identical on every device and in every family view. 0–100, weighted:

```
Passport completeness      30
Vaccinations valid & current 25   (Meningococcal ACWY mandatory → hard gate, caps score at 60 if missing/expired)
Medicines packed + supply covering trip length  20
Emergency contacts ≥1 with WhatsApp  10
Physical baseline (7-day avg steps vs target)  10
Profile basics              5
```

Return the score **with its component breakdown and the top 3 actionable gaps**, localized. A bare number is not useful to a 62-year-old first-time pilgrim.

Never return a diagnosis, an interpretation of a vital as a medical conclusion, or a treatment suggestion. Out-of-range flags say "outside the range you set with your doctor — consider contacting them", nothing more.

---

## 7. Health Passport & selective sharing

```
GET  /passport                         completion %, section states, gaps
POST /passport/generate                → PDF + QR, returns share token
GET  /passport/pdf                     signed URL, 15-min expiry
POST /passport/share                   { recipientType, scopes[], expiresAt } → grant + QR payload
GET  /passport/shared/:token           public-ish read, scope-filtered, rate-limited, audited
DELETE /passport/share/:grantId        revoke
GET  /sharing/grants                   what I've shared, with whom, what scopes
GET  /sharing/received                 what others shared with me
```

### Section completeness

`personal_info`, `emergency_contact`, `allergies`, `medical_conditions`, `medicines`, `travel_health_docs`, `final_review`. Each returns `COMPLETE | PARTIAL | EMPTY` plus the specific missing fields. Recomputed on write (event-driven), not on read — `passportCompleteness.job.ts`.

### Scope filtering is the security boundary

`passportProjection.service.ts` takes `(ownerId, grant)` and returns only permitted fields. **Every** read path — QR, PDF, family view, clinician view, emergency view — goes through this one function. Do not build a second projection anywhere.

| Scope | Exposes |
|---|---|
| `HEALTH_STATUS` | Name, age, blood type, readiness, current alert state. No diagnoses. |
| `FULL_MEDICAL` | Conditions, allergies, vaccinations, clinical notes, vitals history. |
| `LIVE_LOCATION` | Last known point + accuracy + timestamp. |
| `MEDICATION_LIST` | Medicines, doses, adherence. |

`EMERGENCY` recipient type is special: it unlocks a fixed critical-info subset (allergies, conditions, blood type, critical medicines, emergency contacts) **only while an `SosEvent` is ACTIVE**, and every access is audited and surfaced to the user afterwards ("Dr. X viewed your emergency info at 14:32"). It is not a permanent grant.

QR payload contains a short opaque token only — never PHI, never a JWT with claims in it. Tokens are single-season, revocable, and default to 24h for clinician shares.

---

## 8. Environmental safety & heat engine

Heat is the single largest killer at Hajj. Treat this subsystem as safety-critical.

```
GET  /environment/current?lat=&lng=          temp, humidity, heat index, WBGT est, tier, guidance
GET  /environment/forecast?lat=&lng=         hourly, 24h
POST /environment/hydration/log              { amountMl, at }
GET  /environment/hydration/today            intake vs target, deficit
POST /environment/exposure                   client reports sustained outdoor exposure minutes
```

### Heat index

`lib/heat/heatIndex.ts` — Rothfusz regression in °F with the standard low-humidity and high-humidity adjustments, converted back to °C. Include the adjustment branches; the plain polynomial is wrong below 80°F and misleading at RH < 13%. Cache per H3 res-7 cell for 15 minutes to keep provider costs sane.

### Risk tiers → action (returned localized, with `tier` stable for the client)

| Tier | Heat index | Guidance |
|---|---|---|
| `SAFE` | < 32°C | Normal hydration reminders. |
| `CAUTION` | 32–40°C | Increase fluids, seek shade during peak hours. |
| `HIGH` | 41–53°C | Limit outdoor rituals, umbrella, cooling. Push alert. |
| `EXTREME` | > 54°C | Stay indoors/shaded, alert family group, elevate SOS readiness. |

Adjust thresholds **downward** for users flagged with cardiac conditions, diabetes, renal conditions, or age ≥ 65 — `heatRisk.service.ts` applies a per-user offset from `HealthProfile`. This personalization is the point of the feature; a generic weather warning is not a product.

Hydration target: baseline 2.5 L/day, scaled by heat tier, activity minutes, and weight. Cap the recommendation and add a fluid-restriction guard for users with renal or heart-failure flags — **over-hydration advice can kill these users.** If such a flag exists, return `targetMl: null` with a "follow your doctor's fluid limit" message instead of a number.

Alerts are deduped through `AlertDelivery`: at most one alert per tier-transition per user per 3 hours. Alert fatigue means ignored alerts.

---

## 9. Medicines

```
CRUD  /medicines
CRUD  /medicines/:id/schedules
GET   /medicines/doses?from=&to=          materialized instances, 14 days ahead
POST  /medicines/doses/:id/log            { status, takenAt, offline }
POST  /medicines/doses/batch-log          offline flush
GET   /medicines/adherence?range=         % taken, missed streaks, critical-med misses
GET   /medicines/checklist                travel packing: qty needed vs on hand
PUT   /medicines/checklist/:id
POST  /medicines/inquiry                  → PharmacistInquiry (human queue)
GET   /medicines/inquiry/:id
```

Dose generation job runs nightly, materializing 14 days forward per active schedule, in the user's *current* zone (home zone before departure, Asia/Riyadh after). On timezone change, regenerate future PENDING doses and never duplicate a dose already logged.

Supply math for the checklist: `dosesPerDay × (tripDays + 7 buffer)` and flag `requires_refrigeration` and `is_critical` items prominently — Saudi customs and 45°C tents both matter here.

**Hard rules:** no dosage advice, no interaction checking, no substitution suggestions generated by this backend. Inquiries route to a licensed human. If a feature request sounds like "auto-answer medicine questions", escalate rather than implement.

---

## 10. Hajj, family, and emergency

### Hajj
```
GET  PUT  /hajj/rituals              progress tracker, ordered, with next-step guidance
GET       /hajj/guides?locale=       offline guide manifest
CRUD      /hajj/trip                 flights, hotel, visa
CRUD      /hajj/pins                 tent/camp/meeting points
GET       /hajj/pins/nearby?lat=&lng=&radius=
GET       /content/offline-packs?locale=&appVersion=
```

### Family
```
POST /family/groups                  create
POST /family/groups/join             { inviteCode }
GET  /family/groups/:id/members      scope-filtered snapshot per member
PUT  /family/members/:id/scopes      what I share with this group
POST /family/location                { lat, lng, accuracy, battery, at }  ← batched, ≤60s cadence
GET  /family/groups/:id/map          last-known positions of consenting members
POST /family/checkin                 "I'm OK" ping
GET  /family/dependents/:id/health   guardian view, requires DEPENDENT role + guardian link
```

Dependents (elderly parents, minors) require an explicit `guardian_id` link and a recorded consent event. A guardian relationship is **not** implied by group membership. Return `DEPENDENT_CONSENT_REQUIRED` otherwise.

Location writes are high-volume: accept batches, write to Redis first, flush to Postgres every 60s, keep only 24h of trail unless the user opts into more.

### Emergency
```
POST /emergency/sos            { lat, lng, accuracy, battery, type?, note? } → SosEvent
POST /emergency/sos/:id/ack    responder acknowledges
POST /emergency/sos/:id/resolve { resolution }
GET  /emergency/sos/active     for family/operator dashboards
GET  /emergency/nearby         clinics, hospitals, Saudi Red Crescent points
```

SOS fan-out, in order, all within `sosEscalation.job.ts`:

1. **t+0s** — push + Socket.IO to all family group members and emergency contacts, with live coordinates and a critical medical snapshot.
2. **t+0s** — WhatsApp/SMS to emergency contacts (deep link with coordinates). SMS is the fallback that actually works on a foreign SIM.
3. **t+60s** if unacknowledged — notify the Hajj/Umrah operator contact.
4. **t+180s** if unacknowledged — surface local emergency services info (997 Saudi Red Crescent) to the user and flag the event for the operator dashboard.

The client must be able to fire an SOS with cached contacts and no network (direct dial + SMS). This API records and amplifies; it is never the only path. Test the offline path explicitly.

---

## 11. Offline sync

```
GET  /sync/pull?since=<cursor>&entities=vitals,doses,rituals,pins
POST /sync/push   { changes: [{ entity, clientId, op, version, payload, clientUpdatedAt }] }
     → { applied[], conflicts[], serverCursor }
```

Rules:
- Client generates UUID v7 `clientId` for every record. Server upserts on `(user_id, entity, client_id)`. Replaying a push is a no-op — this is the whole design.
- Conflict resolution: **last-write-wins by `clientUpdatedAt`**, except for `MedicationDose` and `SosEvent`, where a `TAKEN` / `RESOLVED` state always beats a `PENDING` / `ACTIVE` state regardless of timestamp. Losing a "dose taken" record causes a double-dose. Losing an SOS resolution causes a false alarm.
- Return conflicts explicitly with both versions; never silently discard client data.
- Cap `changes` at 500 per request; return `413` with guidance to chunk.
- Device clocks drift badly. Record both `clientUpdatedAt` and server receipt time, and if the skew exceeds 10 minutes, flag it in the response so the client can resync its clock.

---

## 12. Security & privacy

This app holds medical records and live location for elderly people, in a country with the Saudi PDPL and users from GDPR jurisdictions. Handle it accordingly.

- **Field-level encryption** (AES-256-GCM, per-field IV, key from KMS/env `FIELD_ENCRYPTION_KEY`, versioned via `key_id`) for: clinical notes, condition notes, allergy reactions, vaccination certificate refs, raw receipts, inquiry text. `lib/crypto/fieldCipher.ts` — use the Prisma extension, don't hand-roll per call site.
- **Pino redaction list:** `req.headers.authorization`, `req.body.code`, `*.phone`, `*.email`, `*.dob`, `*.lat`, `*.lng`, `*.location`, `*.clinicalNotes`, `*.conditions`, `*.allergies`, `*.medicines`, `*.receipt`, `*.purchaseToken`. **Never log a request body from `/health/*`, `/medicines/*`, or `/family/location`.**
- TLS everywhere; HSTS; no PHI in URLs or query strings (that's why passport share uses opaque tokens, not IDs).
- Rate limits: OTP 5/hour/phone; SOS 10/hour/user (generous — a panicking user taps repeatedly); location 120/hour; sharing token reads 60/hour/token; global 300/min/user.
- **Data subject rights:** `GET /privacy/export` (full JSON + PDF bundle) and `DELETE /privacy/account` (30-day soft delete, then hard purge, audit rows retained anonymized). Both are legal requirements, not nice-to-haves.
- Retention: location trail 24h (opt-in 30d), vitals 5 years, audit logs 7 years, OTP challenges 24h.
- Secrets only via env, validated at boot by `config/env.ts` (Zod). **Boot must fail loudly on a missing secret** rather than starting with a silent default.

---

## 13. Localization

Seven locales: `en`, `ar`, `ur`, `id`, `fr`, `bn`, `tr`. Arabic and Urdu are RTL — that's a client concern, but server-generated PDFs are not.

- Server owns: error messages, push notification copy, guidance strings, PDF passport rendering, alert text.
- `lib/i18n/` with ICU MessageFormat, one JSON catalog per locale. Missing key → fall back to `en` **and log a warning** so gaps get found.
- Notification copy is looked up by the *recipient's* locale, not the sender's. A Turkish father must get the Turkish SOS alert about his Indonesian-speaking son.
- Passport PDF: embed Noto Naskh Arabic / Noto Nastaliq Urdu / Noto Sans Bengali. Do not rely on system fonts in the container.
- Dates: Gregorian + Hijri (`hijri-date` or `@umalqura/core`) side by side in all user-facing output. Ritual days are Hijri.

---

## 14. Jobs

| Job | Schedule | Purpose |
|---|---|---|
| `medicationReminder` | every 5 min | Push for doses due; skip if client confirmed local notification fired. |
| `doseMaterialization` | nightly 02:00 | Generate 14 days of dose instances. |
| `heatWatch` | every 30 min (peak season: 15 min) | Poll weather for active-user cells, evaluate personalized tiers, dispatch deduped alerts. |
| `passportCompleteness` | event-driven | Recompute % and readiness on any health write. |
| `entitlementExpiry` | daily | Flag passes past grace; **never delete user data on expiry.** |
| `sosEscalation` | on demand | The escalation ladder in §10. |
| `preDepartureReminders` | daily 09:00 local | Countdown milestones: T-60 vaccinations, T-30 medicine supply, T-14 passport, T-7 packing. |
| `locationFlush` | every 60s | Redis → Postgres. |
| `receiptReverify` | daily | Catch refunds/chargebacks the webhooks missed. |

All jobs are idempotent and safe to re-run. Every job writes a run record with outcome counts.

---

## 15. Testing & definition of done

- Unit tests for every service; the heat index, readiness score, dose materialization, scope projection, and sync conflict resolver require **table-driven tests with edge cases** — these are where real bugs hide.
- Integration tests via Supertest + Testcontainers. Never mock Prisma in integration tests.
- Required scenarios: expired entitlement blocks premium but not SOS; revoked grant returns 403 immediately; duplicate receipt rejected; replayed sync push is a no-op; dose `TAKEN` beats `PENDING` in conflict; heat tier lowered for a cardiac user; passport projection leaks nothing outside its scopes.
- Coverage floor 80%; 95% on `services/sharing`, `services/subscription`, `services/emergency`.

**A PR is done when:** tests pass, OpenAPI is regenerated, a migration exists if the schema changed, new PHI fields are added to the encryption *and* redaction lists, error codes are registered, new user-facing strings exist in all 7 catalogs, and rate limits are set on any new public endpoint.

---

## 16. Working agreements for Claude in this repo

**Do:**
- Read the relevant section above before writing code, and follow the existing patterns in the nearest sibling module.
- Write the Zod schema first, derive types from it, and let OpenAPI fall out of that.
- Ask before adding a dependency, changing the response envelope, or altering an existing v1 shape.
- Add a migration for every schema change; never edit an applied migration.
- Prefer boring, explicit code. This is health software read at 3am by someone debugging why an alert didn't fire.

**Don't:**
- Introduce recurring billing concepts. The model is one-off, season-scoped.
- Put a paywall in front of SOS, emergency contacts, allergies, or the medication list.
- Generate medical advice, dosages, interaction warnings, or diagnoses from any code path.
- Log PHI, or put identifiers in URLs for shared resources.
- Widen a sharing scope, add a new one, or bypass `passportProjection.service.ts`.
- Silently drop client data during sync.

---

## 17. Open questions (spec gaps — resolve before building these)

The v2.0 spec jumps from Section 2 to Section 4; Section 3 and the screens after Screen 6 are not defined. Flag rather than invent:

1. **Section 3 is missing entirely** — likely the Home/dashboard spec. Dashboard aggregation endpoint (`GET /home/dashboard`) is inferred from the tab description; confirm its contents.
2. Pharmacist inquiry: who staffs it, what SLA, is it in-app chat or ticketed?
3. Operator integration: is there a partner-facing API and dashboard, or do operators use the same app?
4. Wearables: which devices? Apple HealthKit / Google Health Connect only (client-side), or direct Fitbit/Garmin OAuth (server-side)?
5. Weather provider and budget — determines cache TTL and cell resolution.
6. Refund policy for a one-off pass, and what happens to a user whose Hajj is cancelled after purchase (carry-over to next season?).
7. Payment provider for the Saudi/web channel: Tap, HyperPay, Moyasar, or Stripe?
8. Does the emergency broadcast integrate with any official Saudi service (997 / Tawakkalna / Nusuk), or is it contacts-only?
9. Data residency: must PHI stay in-Kingdom under PDPL for pilgrims in Saudi Arabia?
10. Dependent consent for pilgrims with cognitive impairment — what's the legal basis and the recorded artifact?

---

## 18. Environment variables

```bash
NODE_ENV=            PORT=            API_BASE_URL=
DATABASE_URL=        REDIS_URL=
JWT_ACCESS_SECRET=   JWT_REFRESH_SECRET=   JWT_ACCESS_TTL=15m   JWT_REFRESH_TTL=30d
FIELD_ENCRYPTION_KEY=   FIELD_ENCRYPTION_KEY_ID=
OTP_PROVIDER=        OTP_API_KEY=          WHATSAPP_API_TOKEN=   WHATSAPP_PHONE_ID=
FCM_SERVICE_ACCOUNT_JSON=
APPLE_BUNDLE_ID=     APPLE_ISSUER_ID=      APPLE_KEY_ID=         APPLE_PRIVATE_KEY=
GOOGLE_PACKAGE_NAME= GOOGLE_SERVICE_ACCOUNT_JSON=
STRIPE_SECRET_KEY=   STRIPE_WEBHOOK_SECRET=
TAP_SECRET_KEY=      TAP_WEBHOOK_SECRET=
WEATHER_API_KEY=     WEATHER_PROVIDER=
S3_BUCKET=           S3_REGION=            S3_ACCESS_KEY=        S3_SECRET_KEY=
SENTRY_DSN=          LOG_LEVEL=info
DEFAULT_LOCALE=en    SUPPORTED_LOCALES=en,ar,ur,id,fr,bn,tr
```

Every one of these is validated in `config/env.ts` at boot.