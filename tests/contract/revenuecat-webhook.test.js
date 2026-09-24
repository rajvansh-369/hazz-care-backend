'use strict';

/**
 * POST /api/v1/webhooks/revenuecat (BACKEND_SPEC.md §6b, CLAUDE.md A5).
 *
 * Server-to-server: the app never calls it, so the /auth status rules do not apply. It
 * answers exactly 200, 400, 401 or 503.
 */

const crypto = require('crypto');
const request = require('supertest');

const app = require('../../src/app');
const config = require('../../src/config/config');
const logger = require('../../src/config/logger');
const { AliasLink, Entitlement, RevenueCatEvent, User } = require('../../src/models');
const revenueCatService = require('../../src/services/revenueCat.service');
const { findPurchase } = require('../../scripts/find-purchase');
const setupTestDB = require('../utils/setupTestDB');

const URL = `${config.apiPrefix}/webhooks/revenuecat`;
const PASS = 'hajjcare_pass';
const PURCHASED_AT_MS = 1793491200000;
const ANON = '$RCAnonymousID:8f2c1b9e4d7a4c3e9b1f0a6d5e2c7b4a';

const statuses = [];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const hmacHex = (payload, secret = config.revenueCat.webhookHmacSecret) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');
const sign = (raw, t = nowSeconds()) => `t=${t},v1=${hmacHex(`${t}.${raw}`)}`;

const bodyOf = (event) => JSON.stringify({ api_version: '1.0', event });

/** Delivers `raw` signed (unless a signature header is given). */
const post = (raw, headers = {}) => {
  const req = request(app).post(URL).set('Content-Type', 'application/json');
  const withSignature =
    'X-RevenueCat-Webhook-Signature' in headers
      ? headers
      : { 'X-RevenueCat-Webhook-Signature': sign(raw), ...headers };
  Object.entries(withSignature).forEach(([key, value]) => {
    if (value !== undefined) {
      req.set(key, value);
    }
  });
  return req.send(raw).then((res) => {
    statuses.push(res.status);
    return res;
  });
};

/** Delivers an event and waits until its processing has finished. */
const deliver = async (event, headers) => {
  const res = await post(bodyOf(event), headers);
  await revenueCatService.idle();
  return res;
};

let sequence = 0;
const eventFor = (appUserId, overrides = {}) => {
  sequence += 1;
  return {
    id: `evt-${sequence}-${crypto.randomUUID()}`,
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: appUserId,
    original_app_user_id: appUserId,
    aliases: [appUserId],
    product_id: 'some_unpinned_sku',
    entitlement_ids: [PASS],
    period_type: 'NORMAL',
    purchased_at_ms: PURCHASED_AT_MS,
    expiration_at_ms: null,
    store: 'APP_STORE',
    environment: 'PRODUCTION',
    price: 14.99,
    currency: 'USD',
    transaction_id: `2000000${sequence}`,
    is_family_share: false,
    ...overrides,
  };
};

let userSequence = 0;
const createUser = async () => {
  userSequence += 1;
  const user = await User.create({
    email: `pilgrim${userSequence}@example.com`,
    passwordHash: 'not-a-real-hash',
  });
  return { id: String(user._id), email: user.email };
};

const entitlementOf = (userId) => Entitlement.findOne({ user: userId }).lean();
const stored = (id) => RevenueCatEvent.findById(id).lean();
/** The entitlement without bookkeeping fields, for before/after comparisons. */
const snapshot = async () =>
  (await Entitlement.find().sort({ user: 1 }).lean()).map(({ updatedAt, __v, ...rest }) => rest);

describe('POST /webhooks/revenuecat', () => {
  setupTestDB();

  beforeAll(async () => {
    await Promise.all([User, Entitlement, AliasLink, RevenueCatEvent].map((m) => m.createCollection()));
    await Promise.all([User, Entitlement, AliasLink, RevenueCatEvent].map((m) => m.init()));
  });

  afterEach(async () => {
    await revenueCatService.idle();
    jest.restoreAllMocks();
  });

  describe('HMAC signing (RC_WEBHOOK_HMAC_SECRET set)', () => {
    it('a valid signature → 200', async () => {
      const user = await createUser();
      const res = await deliver(eventFor(user.id));
      expect(res.status).toBe(200);
      expect(await RevenueCatEvent.countDocuments()).toBe(1);
    });

    it('a wrong signature → 401 unauthorized, nothing stored', async () => {
      const raw = bodyOf(eventFor('someone'));
      const t = nowSeconds();
      const res = await post(raw, {
        'X-RevenueCat-Webhook-Signature': `t=${t},v1=${hmacHex(`${t}.${raw}`, 'x'.repeat(40))}`,
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
      expect(await RevenueCatEvent.countDocuments()).toBe(0);
    });

    it('a timestamp 301 seconds old → 401; 299 seconds old → 200', async () => {
      const stale = bodyOf(eventFor('someone'));
      expect((await post(stale, { 'X-RevenueCat-Webhook-Signature': sign(stale, nowSeconds() - 301) })).status).toBe(401);
      const fresh = bodyOf(eventFor('someone'));
      expect((await post(fresh, { 'X-RevenueCat-Webhook-Signature': sign(fresh, nowSeconds() - 299) })).status).toBe(200);
    });

    it('a body re-serialised after signing → 401', async () => {
      const raw = JSON.stringify({ api_version: '1.0', event: eventFor('someone') }, null, 2);
      const signature = sign(raw);
      const reserialised = JSON.stringify(JSON.parse(raw));
      const res = await post(reserialised, { 'X-RevenueCat-Webhook-Signature': signature });
      expect(res.status).toBe(401);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['no timestamp', 'v1=abc'],
      ['not hex', 't=1,v1=zz'],
    ])('a %s signature header → 401', async (_label, header) => {
      const res = await post(bodyOf(eventFor('someone')), { 'X-RevenueCat-Webhook-Signature': header });
      expect(res.status).toBe(401);
    });

    it('the shared secret alone is not enough while signing is configured', async () => {
      const res = await post(bodyOf(eventFor('someone')), {
        'X-RevenueCat-Webhook-Signature': undefined,
        Authorization: config.revenueCat.webhookSecret,
      });
      expect(res.status).toBe(401);
    });
  });

  describe('shared secret (RC_WEBHOOK_HMAC_SECRET unset)', () => {
    let hmacSecret;
    beforeEach(() => {
      hmacSecret = config.revenueCat.webhookHmacSecret;
      config.revenueCat.webhookHmacSecret = undefined;
    });
    afterEach(() => {
      config.revenueCat.webhookHmacSecret = hmacSecret;
    });

    const withAuthorization = (value) => ({ 'X-RevenueCat-Webhook-Signature': undefined, Authorization: value });

    it('the right Authorization header → 200', async () => {
      const res = await post(bodyOf(eventFor('someone')), withAuthorization(config.revenueCat.webhookSecret));
      expect(res.status).toBe(200);
    });

    it.each([
      ['wrong', 'wrong-secret-of-a-plausible-length-000000000'],
      ['the secret with a Bearer prefix', `Bearer ${'s'}`],
      ['missing', undefined],
    ])('a %s Authorization header → 401', async (_label, value) => {
      const res = await post(bodyOf(eventFor('someone')), withAuthorization(value));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });
  });

  describe('body', () => {
    it.each([
      ['not JSON', 'this is not json'],
      ['an empty body', ''],
      ['JSON with no event', '{"api_version":"1.0"}'],
      ['an event with no id', bodyOf({ type: 'NON_RENEWING_PURCHASE' })],
      ['an event id that is not a string', bodyOf({ id: 42, type: 'NON_RENEWING_PURCHASE' })],
      ['a JSON array', '[1,2,3]'],
    ])('%s → 400 invalid_input', async (_label, raw) => {
      const res = await post(raw);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'invalid_input' });
      expect(await RevenueCatEvent.countDocuments()).toBe(0);
    });

    it('a body over 1mb → 400', async () => {
      const raw = bodyOf(eventFor('someone', { padding: 'x'.repeat(1024 * 1024) }));
      expect((await post(raw)).status).toBe(400);
    });

    it('snake_case keys are read as they arrive (§7.1 carve-out), and rawBody is the exact string sent', async () => {
      const user = await createUser();
      const event = eventFor(user.id, { aliases: [user.id, ANON] });
      const raw = `{ "api_version" : "1.0",\n  "event": ${JSON.stringify(event, null, 3)} }`;
      expect((await post(raw)).status).toBe(200);
      await revenueCatService.idle();

      const doc = await stored(event.id);
      expect(doc).toMatchObject({
        type: 'NON_RENEWING_PURCHASE',
        appUserId: user.id,
        aliases: [user.id, ANON],
        environment: 'PRODUCTION',
        entitlementIds: [PASS],
      });
      expect(doc.rawBody).toBe(raw);
      expect(await entitlementOf(user.id)).not.toBeNull();
    });
  });

  describe('storage', () => {
    it('TEST → 200 and nothing stored', async () => {
      const res = await deliver(eventFor('someone', { type: 'TEST' }));
      expect(res.status).toBe(200);
      expect(await RevenueCatEvent.countDocuments()).toBe(0);
      expect(await AliasLink.countDocuments()).toBe(0);
    });

    it('the same event delivered twice → both 200, stored once, processed once', async () => {
      const user = await createUser();
      const event = eventFor(user.id);
      expect((await deliver(event)).status).toBe(200);
      const first = await stored(event.id);
      expect(first.processedAt).toBeInstanceOf(Date);

      expect((await deliver(event)).status).toBe(200);
      expect(await RevenueCatEvent.countDocuments()).toBe(1);
      const second = await stored(event.id);
      expect(second.processedAt).toEqual(first.processedAt);
      expect(second.updatedAt).toEqual(first.updatedAt);
    });

    it('a storage failure → 503 unavailable, so RevenueCat retries', async () => {
      jest.spyOn(RevenueCatEvent, 'create').mockRejectedValueOnce(new Error('connection reset'));
      const res = await post(bodyOf(eventFor('someone')));
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });

    it('the 200 is sent before processing finishes', async () => {
      const user = await createUser();
      const event = eventFor(user.id);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const realFindById = RevenueCatEvent.findById.bind(RevenueCatEvent);
      jest
        .spyOn(RevenueCatEvent, 'findById')
        .mockImplementationOnce((id) => ({ lean: () => gate.then(() => realFindById(id).lean()) }));

      const res = await post(bodyOf(event));
      expect(res.status).toBe(200);
      expect((await stored(event.id)).processedAt).toBeNull();
      expect(await entitlementOf(user.id)).toBeNull();

      release();
      await revenueCatService.idle();
      expect((await stored(event.id)).processedAt).toBeInstanceOf(Date);
      expect(await entitlementOf(user.id)).not.toBeNull();
    });

    it('a processing failure is recorded on the event and never thrown', async () => {
      const user = await createUser();
      const event = eventFor(user.id);
      jest.spyOn(Entitlement, 'updateOne').mockRejectedValueOnce(new Error('write conflict'));
      expect((await deliver(event)).status).toBe(200);
      const doc = await stored(event.id);
      expect(doc.processingError).toBe('write conflict');
      expect(doc.processedAt).toBeNull();
    });
  });

  describe('processing', () => {
    it('NON_RENEWING_PURCHASE for a known user id → pass granted, entitlementId from config', async () => {
      const previous = config.revenueCat.entitlementId;
      config.revenueCat.entitlementId = 'custom_pass_from_config';
      try {
        const user = await createUser();
        const event = eventFor(user.id, { entitlement_ids: ['custom_pass_from_config'] });
        await deliver(event);
        expect(await entitlementOf(user.id)).toMatchObject({
          entitlementId: 'custom_pass_from_config',
          store: 'APP_STORE',
          transactionId: event.transaction_id,
          grantedAt: new Date(PURCHASED_AT_MS),
          revokedAt: null,
        });
        expect((await stored(event.id)).processedAt).toBeInstanceOf(Date);
      } finally {
        config.revenueCat.entitlementId = previous;
      }
    });

    it('INITIAL_PURCHASE grants the same way, with a warning', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const user = await createUser();
      await deliver(eventFor(user.id, { type: 'INITIAL_PURCHASE' }));
      expect(await entitlementOf(user.id)).toMatchObject({ entitlementId: PASS, revokedAt: null });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/INITIAL_PURCHASE.*lifetime pass/));
    });

    it('a product the pass does not cover (entitlement_ids lacks the configured id) → no entitlement', async () => {
      const user = await createUser();
      const event = eventFor(user.id, { entitlement_ids: ['some_other_entitlement'] });
      await deliver(event);
      expect(await entitlementOf(user.id)).toBeNull();
      expect((await stored(event.id)).processedAt).toBeInstanceOf(Date);
    });

    it('never keys on product_id: a new SKU with the configured entitlement still grants', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id, { product_id: 'com.hajjcare.pass.renamed_2027' }));
      expect(await entitlementOf(user.id)).not.toBeNull();
    });

    it('an anonymous purchase is kept as unresolved, then granted when a later event links the alias', async () => {
      const purchase = eventFor(ANON, { aliases: [ANON] });
      await deliver(purchase);
      const unresolved = await stored(purchase.id);
      expect(unresolved.processingError).toBe('unresolved');
      expect(unresolved.processedAt).toBeNull();
      expect(await Entitlement.countDocuments()).toBe(0);
      expect(await AliasLink.findOne({ alias: ANON }).lean()).toMatchObject({ user: null });

      // RevenueCat aliases the anonymous id on the next successful logIn; no TRANSFER fires.
      const user = await createUser();
      await deliver(
        eventFor(user.id, {
          type: 'SUBSCRIBER_ALIAS',
          original_app_user_id: ANON,
          aliases: [ANON, user.id],
          entitlement_ids: [],
        })
      );

      expect(await entitlementOf(user.id)).toMatchObject({
        entitlementId: PASS,
        transactionId: purchase.transaction_id,
        revokedAt: null,
      });
      const reconciled = await stored(purchase.id);
      expect(reconciled.processingError).toBeNull();
      expect(reconciled.processedAt).toBeInstanceOf(Date);
      expect(String((await AliasLink.findOne({ alias: ANON }).lean()).user)).toBe(user.id);
    });

    it('an alias already linked resolves later events on its own', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id, { type: 'SUBSCRIBER_ALIAS', aliases: [ANON, user.id], entitlement_ids: [] }));
      await deliver(eventFor(ANON, { aliases: [ANON] }));
      expect(await entitlementOf(user.id)).not.toBeNull();
    });

    it('TRANSFER (array fields) moves the pass to the account in transferred_to', async () => {
      const from = await createUser();
      const to = await createUser();
      const purchase = eventFor(from.id);
      await deliver(purchase);

      const transfer = {
        id: `evt-transfer-${crypto.randomUUID()}`,
        type: 'TRANSFER',
        transferred_from: [from.id, ANON],
        transferred_to: [to.id],
        entitlement_ids: [PASS],
        environment: 'PRODUCTION',
        store: 'APP_STORE',
      };
      expect((await deliver(transfer)).status).toBe(200);

      expect(await entitlementOf(from.id)).toBeNull();
      expect(await entitlementOf(to.id)).toMatchObject({
        entitlementId: PASS,
        transactionId: purchase.transaction_id,
        grantedAt: new Date(PURCHASED_AT_MS),
        revokedAt: null,
      });
      const doc = await stored(transfer.id);
      expect(doc.appUserId).toBe(to.id);
      expect(doc.processedAt).toBeInstanceOf(Date);
    });

    it('CANCELLATION: UNSUBSCRIBE is ignored, CUSTOMER_SUPPORT revokes, then REFUND_REVERSED re-grants', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id));

      await deliver(eventFor(user.id, { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }));
      expect((await entitlementOf(user.id)).revokedAt).toBeNull();

      const refundedAt = PURCHASED_AT_MS + 86400000;
      await deliver(
        eventFor(user.id, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: refundedAt })
      );
      expect((await entitlementOf(user.id)).revokedAt).toEqual(new Date(refundedAt));

      await deliver(eventFor(user.id, { type: 'REFUND_REVERSED' }));
      expect((await entitlementOf(user.id)).revokedAt).toBeNull();
    });

    it('a bare CANCELLATION with no cancel_reason is ignored', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id));
      await deliver(eventFor(user.id, { type: 'CANCELLATION' }));
      expect((await entitlementOf(user.id)).revokedAt).toBeNull();
    });

    it('EXPIRATION → logged loudly, pass unchanged', async () => {
      const error = jest.spyOn(logger, 'error');
      const user = await createUser();
      await deliver(eventFor(user.id));
      const before = await snapshot();
      await deliver(eventFor(user.id, { type: 'EXPIRATION', expiration_at_ms: PURCHASED_AT_MS + 1 }));
      expect(await snapshot()).toEqual(before);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/EXPIRATION.*lifetime/));
    });

    it('TEMPORARY_ENTITLEMENT_GRANT → no entitlement', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id, { type: 'TEMPORARY_ENTITLEMENT_GRANT' }));
      expect(await entitlementOf(user.id)).toBeNull();
    });

    it('an unknown type → 200, stored, nothing changed', async () => {
      const user = await createUser();
      const event = eventFor(user.id, { type: 'SOMETHING_REVENUECAT_ADDS_IN_2027' });
      expect((await deliver(event)).status).toBe(200);
      expect(await stored(event.id)).toMatchObject({ type: 'SOMETHING_REVENUECAT_ADDS_IN_2027' });
      expect(await Entitlement.countDocuments()).toBe(0);
    });

    it('an event with no user id at all is still stored and answered 200', async () => {
      const event = { id: `evt-bare-${crypto.randomUUID()}`, type: 'SOMETHING_NEW' };
      expect((await deliver(event)).status).toBe(200);
      expect(await stored(event.id)).toMatchObject({ appUserId: null, processingError: 'unresolved' });
    });

    it('SANDBOX while NODE_ENV=production → stored, never granted', async () => {
      const previous = config.isProduction;
      config.isProduction = true;
      try {
        const user = await createUser();
        const event = eventFor(user.id, { environment: 'SANDBOX' });
        expect((await deliver(event)).status).toBe(200);
        expect(await stored(event.id)).not.toBeNull();
        expect(await entitlementOf(user.id)).toBeNull();
      } finally {
        config.isProduction = previous;
      }
    });

    it('SANDBOX outside production (staging, local) is applied', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id, { environment: 'SANDBOX' }));
      expect(await entitlementOf(user.id)).not.toBeNull();
    });

    it('processing the same stored event twice leaves the same state', async () => {
      const user = await createUser();
      const other = await createUser();
      const purchase = eventFor(user.id, { aliases: [user.id, ANON] });
      await deliver(purchase);
      const refund = eventFor(user.id, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' });
      await deliver(refund);
      await deliver(eventFor(user.id, { type: 'REFUND_REVERSED' }));
      const transfer = {
        id: `evt-transfer-${crypto.randomUUID()}`,
        type: 'TRANSFER',
        transferred_from: [user.id],
        transferred_to: [other.id],
        entitlement_ids: [PASS],
      };
      await deliver(transfer);
      const before = { entitlements: await snapshot(), links: await AliasLink.countDocuments() };

      await revenueCatService.processEvent(transfer.id);
      await revenueCatService.processEvent(transfer.id);
      expect({ entitlements: await snapshot(), links: await AliasLink.countDocuments() }).toEqual(before);

      // A purchase processed again re-grants exactly what it granted.
      await Entitlement.deleteMany({});
      await revenueCatService.processEvent(purchase.id);
      const once = await snapshot();
      await revenueCatService.processEvent(purchase.id);
      expect(await snapshot()).toEqual(once);
    });
  });

  describe('startup recovery of events stranded by a crash', () => {
    /** An event stored as if a previous process answered 200 and died before processing. */
    const strand = async (event, { ageMs = 5 * 60 * 1000, ...fields } = {}) =>
      RevenueCatEvent.create({
        _id: event.id,
        type: event.type,
        appUserId: event.app_user_id,
        aliases: event.aliases,
        environment: event.environment,
        entitlementIds: event.entitlement_ids,
        rawBody: bodyOf(event),
        receivedAt: new Date(Date.now() - ageMs),
        ...fields,
      });

    it('processes stranded events oldest first, in the background, and logs the counts', async () => {
      const info = jest.spyOn(logger, 'info');
      const warn = jest.spyOn(logger, 'warn');
      const user = await createUser();
      const purchase = eventFor(user.id);
      const refund = eventFor(user.id, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' });
      await strand(refund, { ageMs: 2 * 60 * 1000 });
      await strand(purchase, { ageMs: 10 * 60 * 1000 });

      expect(revenueCatService.recoverStranded()).toBeUndefined();
      // Returned before doing anything: startup is not delayed.
      expect((await stored(purchase.id)).processedAt).toBeNull();

      await revenueCatService.idle();
      expect((await stored(purchase.id)).processedAt).toBeInstanceOf(Date);
      expect((await stored(refund.id)).processedAt).toBeInstanceOf(Date);
      // Purchase first, then the refund: the pass ends up revoked, not re-granted.
      expect((await entitlementOf(user.id)).revokedAt).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalledWith('RevenueCat recovery: 2 stranded event(s) found, processing');
      expect(info).toHaveBeenCalledWith('RevenueCat recovery: 2 of 2 stranded event(s) processed');
    });

    it('leaves alone events younger than 60 seconds, already processed, or with a processingError', async () => {
      const user = await createUser();
      const recent = eventFor(user.id);
      const done = eventFor(user.id, { type: 'REFUND_REVERSED' });
      const failed = eventFor(ANON, { aliases: [ANON] });
      await strand(recent, { ageMs: 10 * 1000 });
      const processedAt = new Date(Date.now() - 60 * 60 * 1000);
      await strand(done, { processedAt });
      await strand(failed, { processingError: 'unresolved' });

      revenueCatService.recoverStranded();
      await revenueCatService.idle();

      expect((await stored(recent.id)).processedAt).toBeNull();
      expect(await entitlementOf(user.id)).toBeNull();
      expect((await stored(done.id)).processedAt).toEqual(processedAt);
      expect((await stored(failed.id)).processingError).toBe('unresolved');
    });

    it('counts an event that is still unresolved after recovery as not processed', async () => {
      const info = jest.spyOn(logger, 'info');
      await strand(eventFor(ANON, { aliases: [ANON] }));
      revenueCatService.recoverStranded();
      await revenueCatService.idle();
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/0 of 1 stranded event\(s\) processed; the rest are unresolved/));
    });

    it('running recovery twice leaves the same state (idempotent)', async () => {
      const user = await createUser();
      await strand(eventFor(user.id));
      revenueCatService.recoverStranded();
      await revenueCatService.idle();
      const once = await snapshot();
      revenueCatService.recoverStranded();
      await revenueCatService.idle();
      expect(await snapshot()).toEqual(once);
    });

    it('a database failure during recovery is logged, never thrown', async () => {
      const error = jest.spyOn(logger, 'error');
      jest.spyOn(RevenueCatEvent, 'find').mockImplementationOnce(() => {
        throw new Error('not primary');
      });
      revenueCatService.recoverStranded();
      await revenueCatService.idle();
      expect(error).toHaveBeenCalledWith('RevenueCat recovery failed: not primary');
    });

    it('with nothing stranded, logs so', async () => {
      const info = jest.spyOn(logger, 'info');
      revenueCatService.recoverStranded();
      await revenueCatService.idle();
      expect(info).toHaveBeenCalledWith('RevenueCat recovery: no stranded events');
    });
  });

  describe('secrets and header values are never logged', () => {
    it('neither the signature, the Authorization value nor the secrets reach the log', async () => {
      const lines = [];
      ['info', 'warn', 'error', 'debug'].forEach((level) =>
        jest.spyOn(logger, level).mockImplementation((...args) => lines.push(JSON.stringify(args)))
      );
      const raw = bodyOf(eventFor('someone'));
      const signature = sign(raw);
      await post(raw, { 'X-RevenueCat-Webhook-Signature': signature });
      await post(raw, { 'X-RevenueCat-Webhook-Signature': `${signature.slice(0, -4)}0000` });
      await post(raw, { 'X-RevenueCat-Webhook-Signature': undefined, Authorization: config.revenueCat.webhookSecret });
      await revenueCatService.idle();

      const output = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      [config.revenueCat.webhookSecret, config.revenueCat.webhookHmacSecret, signature.split('v1=')[1]].forEach(
        (secret) => expect(output).not.toContain(secret)
      );
      expect(output).not.toContain('api_version');
    });
  });

  describe('support lookup (scripts/find-purchase.js)', () => {
    it('prints the account, its pass, its aliases and its events newest first', async () => {
      const user = await createUser();
      const purchase = eventFor(ANON, { aliases: [ANON] });
      await deliver(purchase);
      await deliver(eventFor(user.id, { type: 'SUBSCRIBER_ALIAS', aliases: [ANON, user.id], entitlement_ids: [] }));

      const lines = await findPurchase(`  ${user.email.toUpperCase()} `);
      const text = lines.join('\n');
      expect(lines[0]).toBe(`Account: ${user.id}`);
      expect(text).toContain('Pass: GRANTED');
      expect(text).toContain(`  entitlement id:  ${PASS}`);
      expect(text).toContain('  store:           APP_STORE');
      expect(text).toContain(`  transaction id:  ${purchase.transaction_id}`);
      expect(text).toContain(`  granted at:      ${new Date(PURCHASED_AT_MS).toISOString()}`);
      expect(text).toContain('  revoked at:      -');
      expect(text).toContain(`Alias links (1):\n  ${ANON}`);
      expect(text).toContain('Webhook events (2, newest first):');
      const eventLines = lines.filter((line) => line.includes('  id: evt-'));
      expect(eventLines[0]).toContain('SUBSCRIBER_ALIAS');
      expect(eventLines[1]).toContain('NON_RENEWING_PURCHASE');
      expect(text).not.toContain('api_version');
      expect(text).not.toContain('rawBody');
    });

    it('a revoked pass is shown as REVOKED', async () => {
      const user = await createUser();
      await deliver(eventFor(user.id));
      await deliver(eventFor(user.id, { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }));
      expect((await findPurchase(user.email)).join('\n')).toContain('Pass: REVOKED');
    });

    it('an unknown email prints "no account"', async () => {
      expect(await findPurchase('nobody@example.com')).toEqual(['no account']);
    });
  });

  describe('everything seen in this file', () => {
    it('only ever answered 200, 400, 401 or 503', () => {
      expect(statuses.length).toBeGreaterThan(30);
      expect([...new Set(statuses)].every((status) => [200, 400, 401, 503].includes(status))).toBe(true);
    });
  });
});
