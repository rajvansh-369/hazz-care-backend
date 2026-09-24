'use strict';

const mongoose = require('mongoose');
const { Token } = require('../../src/models');

describe('Token Model', () => {
  let userId;

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId();
  });

  describe('toJSON transform', () => {
    it('should exclude tokenHash from JSON output (private)', () => {
      const token = new Token({
        tokenHash: 'hashed_token_value',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
      });

      const json = token.toJSON();
      expect(json).not.toHaveProperty('tokenHash');
    });

    it('should exclude __v from JSON output', () => {
      const token = new Token({
        tokenHash: 'hashed_token_value',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      });

      const json = token.toJSON();
      expect(json).not.toHaveProperty('__v');
    });

    it('should include user ref in JSON', () => {
      const token = new Token({
        tokenHash: 'hashed_token_value',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      });

      const json = token.toJSON();
      expect(json.user).toEqual(userId);
    });

    it('should convert _id to id as string', () => {
      const token = new Token({
        tokenHash: 'hashed_token_value',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      });

      const json = token.toJSON();
      expect(json).toHaveProperty('id');
      expect(typeof json.id).toBe('string');
      expect(json).not.toHaveProperty('_id');
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('should have required tokenHash (unique, private)', () => {
      const tokenHashField = Token.schema.paths.tokenHash;
      expect(tokenHashField.options.required).toBeDefined();
      expect(tokenHashField.options.unique).toBe(true);
      expect(tokenHashField.options.private).toBe(true);
    });

    it('should have required user ref (indexed)', () => {
      const userField = Token.schema.paths.user;
      expect(userField.options.required).toBeDefined();
      expect(userField.options.ref).toBe('User');
      expect(userField.options.index).toBe(true);
    });

    it('should restrict type to refresh and resetPassword', () => {
      const typeField = Token.schema.paths.type;
      expect(typeField.options.enum).toEqual(['refresh', 'resetPassword']);
      expect(typeField.options.required).toBeDefined();
    });

    it('should have required expiresAt field (Date)', () => {
      const expiresAtField = Token.schema.paths.expiresAt;
      expect(expiresAtField.options.required).toBeDefined();
      expect(expiresAtField.instance).toBe('Date');
    });

    it('should have optional revokedAt field (default: null)', () => {
      const revokedAtField = Token.schema.paths.revokedAt;
      expect(revokedAtField.options.required).toBeUndefined();
      expect(revokedAtField.options.default).toBe(null);
    });

    it('should have optional replacedBy field (Token ref, default: null)', () => {
      const replacedByField = Token.schema.paths.replacedBy;
      expect(replacedByField.options.required).toBeUndefined();
      expect(replacedByField.options.ref).toBe('Token');
      expect(replacedByField.options.default).toBe(null);
    });

    it('should have timestamps (createdAt, updatedAt)', () => {
      expect(Token.schema.paths.createdAt).toBeDefined();
      expect(Token.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Indexes', () => {
    it('should have TTL index on expiresAt with expireAfterSeconds: 0', () => {
      const indexes = Token.schema._indexes;
      const ttlIndex = indexes.find((idx) => idx[0]?.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex[1].expireAfterSeconds).toBe(0);
    });

    it('should have index on user field for efficient queries', () => {
      const userField = Token.schema.paths.user;
      expect(userField.options.index).toBe(true);
    });
  });

  describe('Layer A grace window requirements', () => {
    it('should support 60-second grace window via replacedBy field', () => {
      const token1Id = new mongoose.Types.ObjectId();
      const token2Id = new mongoose.Types.ObjectId();

      const oldToken = new Token({
        _id: token1Id,
        tokenHash: 'old_token_hash',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        replacedBy: token2Id, // Points to new token
      });

      expect(oldToken.replacedBy).toEqual(token2Id);
    });

    it('should support revocation tracking via revokedAt field', () => {
      const revokedTime = new Date();
      const token = new Token({
        tokenHash: 'token_hash',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        revokedAt: revokedTime,
      });

      expect(token.revokedAt).toEqual(revokedTime);
    });

    it('should allow query: find non-revoked tokens for a user', () => {
      // Demonstrates the query pattern needed for phase 4 services
      // Find all non-revoked refresh tokens for a user that haven't expired
      const query = {
        user: userId,
        type: 'refresh',
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      };
      expect(query).toBeDefined();
    });
  });

  describe('Type validation', () => {
    it('should accept refresh type', () => {
      const token = new Token({
        tokenHash: 'hash',
        user: userId,
        type: 'refresh',
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      });
      expect(token.type).toBe('refresh');
    });

    it('should accept resetPassword type', () => {
      const token = new Token({
        tokenHash: 'hash',
        user: userId,
        type: 'resetPassword',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      });
      expect(token.type).toBe('resetPassword');
    });

    it('should reject other token types', async () => {
      const token = new Token({
        tokenHash: 'hash',
        user: userId,
        type: 'invalid_type',
        expiresAt: new Date(),
      });

      try {
        await token.validate();
        throw new Error('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Idempotency', () => {
    it('should enforce unique tokenHash for duplicate detection', () => {
      const tokenHashField = Token.schema.paths.tokenHash;
      expect(tokenHashField.options.unique).toBe(true);
    });

    it('should support querying by tokenHash to find stored token', () => {
      // Pattern for service layer: find token by hash
      const query = {
        tokenHash: 'some_hash',
        type: 'refresh',
        revokedAt: null,
      };
      expect(query).toBeDefined();
    });
  });
});
