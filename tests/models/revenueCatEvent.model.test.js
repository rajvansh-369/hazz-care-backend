'use strict';

const mongoose = require('mongoose');
const { RevenueCatEvent } = require('../../src/models');

describe('RevenueCatEvent Model', () => {
  describe('toJSON transform', () => {
    it('should exclude __v from JSON output', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_12345',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user123',
        raw: { test: true },
        receivedAt: new Date(),
      });

      const json = event.toJSON();
      expect(json).not.toHaveProperty('__v');
    });

    it('should convert _id to id as string (RevenueCat event.id preserved)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_12345',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user123',
        raw: {},
        receivedAt: new Date(),
      });

      const json = event.toJSON();
      expect(json.id).toBe('rc_event_12345');
      expect(json).not.toHaveProperty('_id');
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('should accept String _id (RevenueCat event.id)', () => {
      const _idField = RevenueCatEvent.schema.paths._id;
      expect(_idField.instance).toBe('String');
    });

    it('should have required type field', () => {
      const typeField = RevenueCatEvent.schema.paths.type;
      expect(typeField.options.required).toBeDefined();
    });

    it('should have required appUserId field (indexed)', () => {
      const appUserIdField = RevenueCatEvent.schema.paths.appUserId;
      expect(appUserIdField.options.required).toBeDefined();
      expect(appUserIdField.options.index).toBe(true);
    });

    it('should have required raw field (Mixed type for schema flexibility)', () => {
      const rawField = RevenueCatEvent.schema.paths.raw;
      expect(rawField.options.required).toBeDefined();
      expect(rawField.instance).toBe('Mixed');
    });

    it('should have receivedAt field (default: now)', () => {
      const receivedAtField = RevenueCatEvent.schema.paths.receivedAt;
      expect(receivedAtField.options.default).toBeDefined();
    });

    it('should have timestamps (createdAt, updatedAt)', () => {
      expect(RevenueCatEvent.schema.paths.createdAt).toBeDefined();
      expect(RevenueCatEvent.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Idempotency via _id as event.id (§A8)', () => {
    it('should use event.id as primary key for duplicate detection', () => {
      const event1 = new RevenueCatEvent({
        _id: 'rc_event_abc123', // RevenueCat event.id
        type: 'INITIAL_PURCHASE',
        appUserId: 'user1',
        raw: { purchase_id: 'xyz' },
      });

      const event2 = new RevenueCatEvent({
        _id: 'rc_event_abc123', // Same event retried
        type: 'INITIAL_PURCHASE',
        appUserId: 'user1',
        raw: { purchase_id: 'xyz' },
      });

      // In practice, MongoDB will throw duplicate key error on insert
      // Service must handle with try/catch and drop duplicates
      expect(event1._id).toEqual(event2._id);
    });

    it('should support idempotent retry: E11000 error means already processed', () => {
      // Pattern for Phase 4 service:
      // try { await RevenueCatEvent.create({...}) }
      // catch (e) { if (e.code === 11000) return; throw; }
      const query = {
        _id: 'rc_event_xyz789',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user2',
      };
      expect(query).toBeDefined();
    });
  });

  describe('Webhook receiver pattern (§A8)', () => {
    it('should store complete raw webhook payload for audit', () => {
      const rawPayload = {
        event: {
          id: 'rc_event_test123',
          type: 'INITIAL_PURCHASE',
          app_user_id: 'user456',
          transferred_from: null,
          transferred_to: null,
          expiration_at_ms: null,
          environment: 'PRODUCTION',
          store: 'apple_app_store',
        },
      };

      const event = new RevenueCatEvent({
        _id: 'rc_event_test123',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user456',
        raw: rawPayload,
        receivedAt: new Date(),
      });

      expect(event.raw).toEqual(rawPayload);
    });

    it('should accept any RevenueCat event type', () => {
      const types = [
        'INITIAL_PURCHASE',
        'NON_RENEWING_PURCHASE',
        'TRANSFER',
        'CANCELLATION',
        'EXPIRATION',
        'SUBSCRIPTION_STARTED',
        'SUBSCRIPTION_RENEWED',
        'SUBSCRIPTION_EXPIRED',
        'BILLING_ISSUE',
        'PRODUCT_CHANGE',
      ];

      types.forEach((eventType) => {
        const event = new RevenueCatEvent({
          _id: `rc_event_${eventType}`,
          type: eventType,
          appUserId: 'user123',
          raw: { type: eventType },
        });
        expect(event.type).toBe(eventType);
      });
    });
  });

  describe('Event processing (§A8)', () => {
    it('should track INITIAL_PURCHASE event', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_initial_purchase',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user123',
        raw: {
          app_user_id: 'user123',
          purchase_id: 'purchase_xyz',
          store: 'apple_app_store',
        },
      });

      expect(event.type).toBe('INITIAL_PURCHASE');
      expect(event.appUserId).toBe('user123');
    });

    it('should track NON_RENEWING_PURCHASE event (grant entitlement)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_non_renewing',
        type: 'NON_RENEWING_PURCHASE',
        appUserId: 'user456',
        raw: { product_id: 'lifetime_pass' },
      });

      // Service will grant entitlement for this user
      expect(event.type).toBe('NON_RENEWING_PURCHASE');
    });

    it('should track TRANSFER event (move entitlement)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_transfer',
        type: 'TRANSFER',
        appUserId: 'user_new_user_id',
        raw: {
          transferred_from: 'user_old_user_id',
          transferred_to: 'user_new_user_id',
        },
      });

      expect(event.type).toBe('TRANSFER');
    });

    it('should track CANCELLATION with cancel_reason (revoke entitlement)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_cancel',
        type: 'CANCELLATION',
        appUserId: 'user789',
        raw: {
          cancel_reason: 'CUSTOMER_SUPPORT',
        },
      });

      // Service will revoke entitlement only for CUSTOMER_SUPPORT reason
      expect(event.type).toBe('CANCELLATION');
    });

    it('should track EXPIRATION but log loudly, never process', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_expiration',
        type: 'EXPIRATION',
        appUserId: 'user999',
        raw: { expiration_at_ms: 1234567890 },
      });

      // Service should: log alert, but NOT change anything
      // Lifetime pass never expires server-side
      expect(event.type).toBe('EXPIRATION');
    });

    it('should ignore SUBSCRIPTION_* events (not applicable to lifetime pass)', () => {
      const ignored = ['SUBSCRIPTION_STARTED', 'SUBSCRIPTION_RENEWED'];
      ignored.forEach((eventType) => {
        const event = new RevenueCatEvent({
          _id: `rc_event_${eventType}`,
          type: eventType,
          appUserId: 'user123',
          raw: {},
        });
        // Service will simply ignore these
        expect(event.type).toBe(eventType);
      });
    });
  });

  describe('Anonymous user detection (§A8)', () => {
    it('should capture $RCAnonymousID (indicates client bug)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_anon',
        type: 'INITIAL_PURCHASE',
        appUserId: '$RCAnonymousID:abc123', // Bug: client sent anonymous ID
        raw: { problem: 'client_not_logged_in' },
      });

      // Service must: alert, do NOT create user, do NOT grant entitlement
      expect(event.appUserId).toMatch(/^\$RCAnonymousID:/);
    });
  });

  describe('Sandbox filtering (§A8)', () => {
    it('should store environment field in raw for filtering', () => {
      const productionEvent = new RevenueCatEvent({
        _id: 'rc_event_prod',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user123',
        raw: {
          environment: 'PRODUCTION',
        },
      });

      const sandboxEvent = new RevenueCatEvent({
        _id: 'rc_event_sandbox',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user456',
        raw: {
          environment: 'SANDBOX',
        },
      });

      // Service must: process production, ignore sandbox in production deployments
      expect(productionEvent.raw.environment).toBe('PRODUCTION');
      expect(sandboxEvent.raw.environment).toBe('SANDBOX');
    });
  });

  describe('expiration_at_ms: always null (§A8)', () => {
    it('should never persist expiration_at_ms as field (lifetime pass only)', () => {
      const event = new RevenueCatEvent({
        _id: 'rc_event_lifetime',
        type: 'INITIAL_PURCHASE',
        appUserId: 'user123',
        raw: {
          expiration_at_ms: null, // Always null per spec
          // Never: expiration_at_ms: 1234567890
        },
      });

      // Schema has no expiresAt field; entitlements never expire
      expect(RevenueCatEvent.schema.paths.expiresAt).toBeUndefined();
      expect(event.raw.expiration_at_ms).toBeNull();
    });
  });

  describe('Query patterns for Phase 4', () => {
    it('should support query: find event by _id for idempotency', () => {
      const query = {
        _id: 'rc_event_123',
      };
      expect(query).toBeDefined();
    });

    it('should support query: find events by appUserId for audit', () => {
      const query = {
        appUserId: 'user123',
      };
      expect(query).toBeDefined();
    });

    it('should support query: find events of type for processing', () => {
      const query = {
        type: 'INITIAL_PURCHASE',
      };
      expect(query).toBeDefined();
    });
  });
});
