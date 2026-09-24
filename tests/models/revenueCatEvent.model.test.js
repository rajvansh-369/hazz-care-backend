'use strict';

const { RevenueCatEvent } = require('../../src/models');

const RAW_BODY =
  '{"api_version":"1.0","event":{"id":"rc_event_12345","type":"NON_RENEWING_PURCHASE",' +
  '"app_user_id":"$RCAnonymousID:abc","aliases":["$RCAnonymousID:abc"],' +
  '"entitlement_ids":["hajjcare_pass"],"environment":"PRODUCTION","expiration_at_ms":null}}';

const newEvent = (overrides = {}) =>
  new RevenueCatEvent({
    _id: 'rc_event_12345',
    type: 'NON_RENEWING_PURCHASE',
    appUserId: 'user123',
    rawBody: RAW_BODY,
    ...overrides,
  });

describe('RevenueCatEvent Model', () => {
  describe('toJSON transform', () => {
    it('excludes __v and exposes event.id as id', () => {
      const json = newEvent().toJSON();
      expect(json).not.toHaveProperty('__v');
      expect(json.id).toBe('rc_event_12345');
      expect(json).not.toHaveProperty('_id');
    });
  });

  describe('Schema fields (Layer A contract §A5, §A8)', () => {
    it('uses a String _id (RevenueCat event.id is the idempotency key)', () => {
      expect(RevenueCatEvent.schema.paths._id.instance).toBe('String');
    });

    it('has a required type and an indexed appUserId that may be null (an event with no user id is still stored)', () => {
      expect(RevenueCatEvent.schema.paths.type.options.required).toBeDefined();
      const appUserId = RevenueCatEvent.schema.paths.appUserId;
      expect(appUserId.options.required).toBeUndefined();
      expect(appUserId.options.default).toBeNull();
      expect(appUserId.options.index).toBe(true);
    });

    it('has a required rawBody String and no parsed `raw` field', () => {
      const field = RevenueCatEvent.schema.paths.rawBody;
      expect(field.instance).toBe('String');
      expect(field.options.required).toBe(true);
      expect(RevenueCatEvent.schema.paths.raw).toBeUndefined();
    });

    it('keeps rawBody byte-for-byte as given', () => {
      expect(newEvent().rawBody).toBe(RAW_BODY);
    });

    it('has aliases as an indexed [String]', () => {
      const field = RevenueCatEvent.schema.paths.aliases;
      expect(field.instance).toBe('Array');
      expect(field.caster.instance).toBe('String');
      expect(field.options.index).toBe(true);
    });

    it('has entitlementIds as a [String] and environment as a String', () => {
      expect(RevenueCatEvent.schema.paths.entitlementIds.caster.instance).toBe('String');
      expect(RevenueCatEvent.schema.paths.environment.instance).toBe('String');
    });

    it.each(['processedAt', 'processingError'])('has %s defaulting to null', (path) => {
      expect(RevenueCatEvent.schema.paths[path].options.default).toBe(null);
      expect(newEvent()[path]).toBeNull();
    });

    it('has receivedAt defaulting to now, and timestamps', () => {
      expect(RevenueCatEvent.schema.paths.receivedAt.options.default).toBeDefined();
      expect(RevenueCatEvent.schema.paths.createdAt).toBeDefined();
      expect(RevenueCatEvent.schema.paths.updatedAt).toBeDefined();
    });

    it('has no expiry path (expiration_at_ms is never persisted)', () => {
      const expiryPaths = Object.keys(RevenueCatEvent.schema.paths).filter((p) =>
        p.toLowerCase().includes('expir')
      );
      expect(expiryPaths).toEqual([]);
    });
  });

  describe('Validation', () => {
    it('rejects an event without rawBody', async () => {
      await expect(newEvent({ rawBody: undefined }).validate()).rejects.toThrow(/rawBody/);
    });

    it('stores an anonymous-id event like any other (BACKEND_SPEC §6b rule 2)', async () => {
      const event = newEvent({
        appUserId: '$RCAnonymousID:abc',
        aliases: ['$RCAnonymousID:abc'],
      });
      await expect(event.validate()).resolves.toBeUndefined();
      expect(event.aliases).toEqual(['$RCAnonymousID:abc']);
    });

    it('accepts any event type, including ones RevenueCat adds later', async () => {
      await expect(newEvent({ type: 'SOME_FUTURE_TYPE' }).validate()).resolves.toBeUndefined();
    });
  });
});
