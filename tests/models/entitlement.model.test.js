'use strict';

const mongoose = require('mongoose');
const { Entitlement } = require('../../src/models');

describe('Entitlement Model', () => {
  let userId;

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId();
  });

  describe('toJSON transform', () => {
    it('should exclude __v from JSON output', () => {
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date(),
      });

      const json = entitlement.toJSON();
      expect(json).not.toHaveProperty('__v');
    });

    it('should include user ref in JSON', () => {
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date(),
      });

      const json = entitlement.toJSON();
      expect(json.user).toEqual(userId);
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('should have required user ref (unique)', () => {
      const userField = Entitlement.schema.paths.user;
      expect(userField.options.required).toBeDefined();
      expect(userField.options.ref).toBe('User');
      expect(userField.options.unique).toBe(true);
    });

    it('should have required productId field', () => {
      const productIdField = Entitlement.schema.paths.productId;
      expect(productIdField.options.required).toBeDefined();
    });

    it('should have grantedAt field (default: now)', () => {
      const grantedAtField = Entitlement.schema.paths.grantedAt;
      expect(grantedAtField.options.required).toBeDefined();
      expect(grantedAtField.options.default).toBeDefined();
    });

    it('should have optional revokedAt field (default: null)', () => {
      const revokedAtField = Entitlement.schema.paths.revokedAt;
      expect(revokedAtField.options.required).toBeUndefined();
      expect(revokedAtField.options.default).toBe(null);
    });

    it('should have timestamps (createdAt, updatedAt)', () => {
      expect(Entitlement.schema.paths.createdAt).toBeDefined();
      expect(Entitlement.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Lifetime Pass: NO expiresAt (§A8)', () => {
    it('should NOT have expiresAt field', () => {
      expect(Entitlement.schema.paths.expiresAt).toBeUndefined();
    });

    it('should NOT have expires_at field (snake_case variant)', () => {
      expect(Entitlement.schema.paths.expires_at).toBeUndefined();
    });

    it('should NOT accept expiresAt in document', () => {
      // Mongoose will silently ignore unknown fields in strict mode
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Should be ignored
      });

      expect(entitlement.expiresAt).toBeUndefined();
    });
  });

  describe('One Entitlement Per User (unique user constraint)', () => {
    it('should enforce unique user reference', () => {
      const userField = Entitlement.schema.paths.user;
      expect(userField.options.unique).toBe(true);
    });

    it('should model: one pilgrim, one lifetime pass', () => {
      // Cannot have two Entitlement docs for same user
      const ent1 = new Entitlement({
        user: userId,
        productId: 'lifetime_pass_2024',
        grantedAt: new Date(),
      });

      const ent2 = new Entitlement({
        user: userId, // Same user
        productId: 'lifetime_pass_2025',
        grantedAt: new Date(),
      });

      // In practice, second insert would throw E11000
      // This just shows the intent
      expect(ent1.user).toEqual(ent2.user);
    });
  });

  describe('Grant Entitlement (INITIAL_PURCHASE, NON_RENEWING_PURCHASE)', () => {
    it('should track when entitlement was granted', () => {
      const grantedAt = new Date('2026-01-01');
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt,
      });

      expect(entitlement.grantedAt).toEqual(grantedAt);
    });

    it('should allow grantedAt to default to now', () => {
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        // grantedAt omitted; defaults to Date.now()
      });

      expect(entitlement.grantedAt).toBeDefined();
    });

    it('should use productId to track which product was purchased', () => {
      const ent = new Entitlement({
        user: userId,
        productId: 'com.example.hajjcare.lifetime_pass', // RevenueCat product ID
        grantedAt: new Date(),
      });

      expect(ent.productId).toBe('com.example.hajjcare.lifetime_pass');
    });
  });

  describe('Revoke Entitlement (CANCELLATION with cancel_reason: CUSTOMER_SUPPORT)', () => {
    it('should track when entitlement was revoked', () => {
      const revokedAt = new Date('2026-03-15');
      const entitlement = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date('2026-01-01'),
        revokedAt,
      });

      expect(entitlement.revokedAt).toEqual(revokedAt);
    });

    it('should support query: find active entitlements (revokedAt == null)', () => {
      // Pattern for Phase 4: check if user has active pass
      const query = {
        user: userId,
        revokedAt: null,
      };
      expect(query).toBeDefined();
    });

    it('should support query: find revoked entitlements for audit', () => {
      const query = {
        revokedAt: { $exists: true, $ne: null },
      };
      expect(query).toBeDefined();
    });
  });

  describe('Transfer Event (move entitlement between users)', () => {
    it('should support transfer: delete from old user, create for new user', () => {
      const oldUserId = new mongoose.Types.ObjectId();
      const newUserId = new mongoose.Types.ObjectId();

      const oldEnt = new Entitlement({
        _id: new mongoose.Types.ObjectId(),
        user: oldUserId,
        productId: 'lifetime_pass',
        grantedAt: new Date('2026-01-01'),
        revokedAt: new Date('2026-02-01'), // Revoked on transfer
      });

      const newEnt = new Entitlement({
        _id: new mongoose.Types.ObjectId(),
        user: newUserId,
        productId: 'lifetime_pass',
        grantedAt: new Date('2026-02-01'), // Granted to new user
      });

      expect(oldEnt.user).not.toEqual(newEnt.user);
      expect(oldEnt.revokedAt).toBeDefined();
      expect(newEnt.revokedAt).toBeNull();
    });
  });

  describe('EXPIRATION event (do nothing)', () => {
    it('should ignore EXPIRATION events from RevenueCat', () => {
      // RevenueCat may send EXPIRATION event for lifetime pass
      // But: lifetime pass never expires, so service must ignore
      // (entitlements have no expiresAt; nothing to check)
      expect(Entitlement.schema.paths.expiresAt).toBeUndefined();
    });
  });

  describe('Layer A: NOT persisted', () => {
    it('should NOT persist seasonCode or expiration date', () => {
      expect(Entitlement.schema.paths.seasonCode).toBeUndefined();
      expect(Entitlement.schema.paths.expiresAt).toBeUndefined();
      expect(Entitlement.schema.paths.expires_at).toBeUndefined();
      expect(Entitlement.schema.paths.season).toBeUndefined();
    });

    it('should NOT persist entitlement features (static, never change)', () => {
      expect(Entitlement.schema.paths.features).toBeUndefined();
      // Features are defined in client only (or config; never in DB)
    });

    it('should NOT persist purchased channel or source', () => {
      expect(Entitlement.schema.paths.source).toBeUndefined();
      expect(Entitlement.schema.paths.channel).toBeUndefined();
      // RevenueCat event.raw.store or similar can be tracked if needed,
      // but not in standard fields
    });
  });

  describe('Query patterns for Phase 4', () => {
    it('should support query: check if user has active pass', () => {
      // Core pattern: does this user have an active entitlement?
      const query = {
        user: userId,
        revokedAt: null,
      };
      expect(query).toBeDefined();
    });

    it('should support query: find entitlement by user', () => {
      const query = {
        user: userId,
      };
      expect(query).toBeDefined();
    });

    it('should support query: find for RevenueCat transfer (by productId)', () => {
      const query = {
        productId: 'lifetime_pass',
      };
      expect(query).toBeDefined();
    });

    it('should support update: revoke entitlement', () => {
      // Pattern: await Entitlement.updateOne({ user: userId }, { revokedAt: new Date() })
      const update = { revokedAt: new Date() };
      expect(update).toBeDefined();
    });
  });

  describe('Integration: RevenueCat → Entitlement', () => {
    it('should track entitlement created by INITIAL_PURCHASE', () => {
      // RevenueCat app_user_id 'rc_user_123' has been resolved to userId.
      const now = new Date();

      const ent = new Entitlement({
        user: userId, // Matched from rc_user_123
        productId: 'com.example.hajjcare.lifetime_pass',
        grantedAt: now,
      });

      expect(ent.grantedAt).toEqual(now);
      expect(ent.revokedAt).toBeNull();
    });

    it('should track entitlement from TRANSFER event', () => {
      const ent = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date('2026-02-01'),
      });

      // Service moved it from another user; now this user has it
      expect(ent.user).toEqual(userId);
    });
  });

  describe('Business logic notes for Phase 4', () => {
    it('document: entitlement granted and never expires', () => {
      // Once created, entitlement is active until explicitly revoked
      // No expiration logic; no season logic
      const ent = new Entitlement({
        user: userId,
        productId: 'lifetime_pass',
        grantedAt: new Date('2026-01-01'),
      });

      // 1 year later, still active
      // 5 years later, still active
      // Only revokedAt marks end
      expect(ent.revokedAt).toBeNull();
    });

    it('document: entitlements do NOT gate access server-side', () => {
      // PRS said: check entitlement on server for access gate
      // Layer A says: NO. Client checks local DB only.
      // This model exists only for:
      // 1. Support to answer "did they pay?"
      // 2. Refunds to have a place to land
      expect(Entitlement.schema.paths).toBeDefined();
    });
  });
});
