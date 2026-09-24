'use strict';

const mongoose = require('mongoose');
const { Entitlement } = require('../../src/models');

describe('Entitlement Model', () => {
  let userId;

  const newEntitlement = (overrides = {}) =>
    new Entitlement({
      user: userId,
      entitlementId: 'hajjcare_pass',
      store: 'APP_STORE',
      transactionId: '2000000123456789',
      ...overrides,
    });

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId();
  });

  describe('toJSON transform', () => {
    it('excludes __v and includes the user ref', () => {
      const json = newEntitlement().toJSON();
      expect(json).not.toHaveProperty('__v');
      expect(json.user).toEqual(userId);
    });
  });

  describe('Schema fields (Layer A contract §A5, §A8)', () => {
    it('has a required, unique user ref (one pass per pilgrim)', () => {
      const field = Entitlement.schema.paths.user;
      expect(field.options.required).toBeDefined();
      expect(field.options.ref).toBe('User');
      expect(field.options.unique).toBe(true);
    });

    it('has a required entitlementId and no productId (never key on product_id)', () => {
      expect(Entitlement.schema.paths.entitlementId.options.required).toBe(true);
      expect(Entitlement.schema.paths.productId).toBeUndefined();
    });

    it('has store and transactionId Strings', () => {
      expect(Entitlement.schema.paths.store.instance).toBe('String');
      expect(Entitlement.schema.paths.transactionId.instance).toBe('String');
    });

    it('has grantedAt defaulting to now and revokedAt defaulting to null', () => {
      const ent = newEntitlement();
      expect(ent.grantedAt).toBeInstanceOf(Date);
      expect(ent.revokedAt).toBeNull();
    });

    it('has timestamps (createdAt, updatedAt)', () => {
      expect(Entitlement.schema.paths.createdAt).toBeDefined();
      expect(Entitlement.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Lifetime pass: no expiry of any kind (BACKEND_SPEC §6b rule 5)', () => {
    it('has no schema path containing "expir"', () => {
      const expiryPaths = Object.keys(Entitlement.schema.paths).filter((p) =>
        p.toLowerCase().includes('expir')
      );
      expect(expiryPaths).toEqual([]);
    });

    it('drops an expiresAt given on construction (strict schema)', () => {
      const ent = newEntitlement({ expiresAt: new Date() });
      expect(ent.expiresAt).toBeUndefined();
      expect(ent.toJSON()).not.toHaveProperty('expiresAt');
    });

    it('has no season field', () => {
      expect(Entitlement.schema.paths.season).toBeUndefined();
      expect(Entitlement.schema.paths.seasonCode).toBeUndefined();
    });
  });

  describe('Validation', () => {
    it('accepts a complete entitlement', async () => {
      await expect(newEntitlement().validate()).resolves.toBeUndefined();
    });

    it('rejects an entitlement without entitlementId', async () => {
      await expect(newEntitlement({ entitlementId: undefined }).validate()).rejects.toThrow(
        /entitlementId/
      );
    });
  });
});
