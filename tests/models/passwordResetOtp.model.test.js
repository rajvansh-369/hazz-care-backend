'use strict';

const mongoose = require('mongoose');
const { PasswordResetOtp } = require('../../src/models');

const newOtp = (overrides = {}) => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  return new PasswordResetOtp({
    email: 'test@example.com',
    user: new mongoose.Types.ObjectId(),
    codeHash: 'hashed_otp_code',
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 24 * 60 * 60 * 1000),
    ...overrides,
  });
};

describe('PasswordResetOtp Model', () => {
  describe('toJSON transform', () => {
    it('excludes codeHash (private) and __v', () => {
      const json = newOtp().toJSON();
      expect(json).not.toHaveProperty('codeHash');
      expect(json).not.toHaveProperty('__v');
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('has a required, indexed, lowercased email', () => {
      const field = PasswordResetOtp.schema.paths.email;
      expect(field.options.required).toBeDefined();
      expect(field.options.index).toBe(true);
      expect(field.options.lowercase).toBe(true);
      expect(newOtp({ email: 'Pilgrim@X.com' }).email).toBe('pilgrim@x.com');
    });

    it('has a required user ref (codes are only issued for real accounts)', () => {
      const field = PasswordResetOtp.schema.paths.user;
      expect(field.options.required).toBe(true);
      expect(field.options.ref).toBe('User');
    });

    it('has a required, private codeHash that is NOT unique', () => {
      const field = PasswordResetOtp.schema.paths.codeHash;
      expect(field.options.required).toBeDefined();
      expect(field.options.private).toBe(true);
      expect(field.options.unique).toBeUndefined();
      const onCodeHash = PasswordResetOtp.schema.indexes().filter(([f]) => 'codeHash' in f);
      expect(onCodeHash).toEqual([]);
    });

    it('has a required expiresAt and a required purgeAt (Dates)', () => {
      ['expiresAt', 'purgeAt'].forEach((path) => {
        const field = PasswordResetOtp.schema.paths[path];
        expect(field.options.required).toBe(true);
        expect(field.instance).toBe('Date');
      });
    });

    it('has attempts defaulting to 0', () => {
      expect(PasswordResetOtp.schema.paths.attempts.options.default).toBe(0);
      expect(newOtp().attempts).toBe(0);
    });

    it.each(['consumedAt', 'supersededAt'])('has %s defaulting to null', (path) => {
      expect(PasswordResetOtp.schema.paths[path].options.default).toBe(null);
    });

    it('has no lockedUntil: lockout is attempts >= max on the active code', () => {
      expect(PasswordResetOtp.schema.paths.lockedUntil).toBeUndefined();
    });

    it('has timestamps (createdAt, updatedAt)', () => {
      expect(PasswordResetOtp.schema.paths.createdAt).toBeDefined();
      expect(PasswordResetOtp.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Indexes', () => {
    it('declares a TTL index on purgeAt with expireAfterSeconds: 0', () => {
      const ttl = PasswordResetOtp.schema.indexes().find(([fields]) => fields.purgeAt === 1);
      expect(ttl).toBeDefined();
      expect(ttl[1].expireAfterSeconds).toBe(0);
    });

    it('declares no index on expiresAt (an expired code must survive for otp_expired)', () => {
      const onExpiresAt = PasswordResetOtp.schema.indexes().filter(([f]) => 'expiresAt' in f);
      expect(onExpiresAt).toEqual([]);
    });

    it('declares the "latest active code for this address" compound index', () => {
      const compound = PasswordResetOtp.schema
        .indexes()
        .find(([fields]) => Object.keys(fields).length === 4);
      expect(compound[0]).toEqual({ email: 1, consumedAt: 1, supersededAt: 1, createdAt: -1 });
    });
  });

  describe('Validation', () => {
    it('accepts a complete document', async () => {
      await expect(newOtp().validate()).resolves.toBeUndefined();
    });

    it('rejects a document without user', async () => {
      await expect(newOtp({ user: undefined }).validate()).rejects.toThrow(/user/);
    });

    it('rejects a document without purgeAt', async () => {
      await expect(newOtp({ purgeAt: undefined }).validate()).rejects.toThrow(/purgeAt/);
    });
  });
});
