'use strict';

const mongoose = require('mongoose');
const { Token } = require('../../src/models');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Token Model', () => {
  let userId;

  const newToken = (overrides = {}) => {
    const expiresAt = new Date(Date.now() + 60 * DAY_MS);
    return new Token({
      tokenHash: 'hashed_token_value',
      user: userId,
      type: 'refresh',
      familyId: 'family-1',
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + 7 * DAY_MS),
      ...overrides,
    });
  };

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId();
  });

  describe('toJSON transform', () => {
    it('excludes tokenHash (private) and __v', () => {
      const json = newToken().toJSON();
      expect(json).not.toHaveProperty('tokenHash');
      expect(json).not.toHaveProperty('__v');
    });

    it('includes the user ref', () => {
      expect(newToken().toJSON().user).toEqual(userId);
    });

    it('converts _id to id as a string', () => {
      const json = newToken().toJSON();
      expect(typeof json.id).toBe('string');
      expect(json).not.toHaveProperty('_id');
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('has a required tokenHash (unique, private)', () => {
      const field = Token.schema.paths.tokenHash;
      expect(field.options.required).toBeDefined();
      expect(field.options.unique).toBe(true);
      expect(field.options.private).toBe(true);
    });

    it('has a required, indexed user ref', () => {
      const field = Token.schema.paths.user;
      expect(field.options.required).toBeDefined();
      expect(field.options.ref).toBe('User');
      expect(field.options.index).toBe(true);
    });

    it('restricts type to refresh and resetPassword', () => {
      const field = Token.schema.paths.type;
      expect(field.options.enum).toEqual(['refresh', 'resetPassword']);
      expect(field.options.required).toBeDefined();
    });

    it('has an indexed familyId (String) for rotation lineage', () => {
      const field = Token.schema.paths.familyId;
      expect(field.instance).toBe('String');
      expect(field.options.index).toBe(true);
    });

    it('has a required expiresAt (Date)', () => {
      const field = Token.schema.paths.expiresAt;
      expect(field.options.required).toBeDefined();
      expect(field.instance).toBe('Date');
    });

    it('has a required purgeAt (Date)', () => {
      const field = Token.schema.paths.purgeAt;
      expect(field.options.required).toBe(true);
      expect(field.instance).toBe('Date');
    });

    it.each(['rotatedAt', 'revokedAt', 'consumedAt'])('has %s (Date) defaulting to null', (path) => {
      const field = Token.schema.paths[path];
      expect(field.instance).toBe('Date');
      expect(field.options.required).toBeUndefined();
      expect(field.options.default).toBe(null);
    });

    it('has an indexed parent (Token ref) defaulting to null: the token it was minted from', () => {
      const field = Token.schema.paths.parent;
      expect(field.options.required).toBeUndefined();
      expect(field.options.ref).toBe('Token');
      expect(field.options.default).toBe(null);
      expect(field.options.index).toBe(true);
    });

    it('has childCount (Number) defaulting to 0', () => {
      const field = Token.schema.paths.childCount;
      expect(field.instance).toBe('Number');
      expect(field.options.default).toBe(0);
    });

    it('no longer has replacedBy: one pointer cannot hold siblings', () => {
      expect(Token.schema.paths.replacedBy).toBeUndefined();
    });

    it('has revokedReason restricted to LOGOUT | SUPERSEDED | PASSWORD_RESET | ADMIN, default null', () => {
      const field = Token.schema.paths.revokedReason;
      expect(field.options.default).toBe(null);
      expect(Token.REVOKED_REASONS).toEqual(['LOGOUT', 'SUPERSEDED', 'PASSWORD_RESET', 'ADMIN']);
    });

    it('has timestamps (createdAt, updatedAt)', () => {
      expect(Token.schema.paths.createdAt).toBeDefined();
      expect(Token.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Indexes', () => {
    it('declares a TTL index on purgeAt with expireAfterSeconds: 0', () => {
      const ttl = Token.schema.indexes().find(([fields]) => fields.purgeAt === 1);
      expect(ttl).toBeDefined();
      expect(ttl[1].expireAfterSeconds).toBe(0);
    });

    it('declares no index on expiresAt at all', () => {
      const onExpiresAt = Token.schema.indexes().filter(([fields]) => 'expiresAt' in fields);
      expect(onExpiresAt).toEqual([]);
    });
  });

  describe('Validation', () => {
    it('accepts a complete refresh token', async () => {
      await expect(newToken().validate()).resolves.toBeUndefined();
    });

    it('accepts a resetPassword token', async () => {
      await expect(newToken({ type: 'resetPassword' }).validate()).resolves.toBeUndefined();
    });

    it('rejects any other token type', async () => {
      await expect(newToken({ type: 'invalid_type' }).validate()).rejects.toThrow(/type/);
    });

    it('rejects a token without purgeAt', async () => {
      await expect(newToken({ purgeAt: undefined }).validate()).rejects.toThrow(/purgeAt/);
    });

    it.each(['LOGOUT', 'SUPERSEDED', 'PASSWORD_RESET', 'ADMIN', null])(
      'accepts revokedReason %p',
      async (reason) => {
        await expect(newToken({ revokedReason: reason }).validate()).resolves.toBeUndefined();
      }
    );

    it.each(['EXPIRED', 'ROTATED'])('rejects revokedReason %p', async (reason) => {
      await expect(newToken({ revokedReason: reason }).validate()).rejects.toThrow(
        /revokedReason/
      );
    });

    it('rejects a negative childCount', async () => {
      await expect(newToken({ childCount: -1 }).validate()).rejects.toThrow(/childCount/);
    });
  });
});
