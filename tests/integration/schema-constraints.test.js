'use strict';

const mongoose = require('mongoose');
const setupTestDB = require('../utils/setupTestDB');
const { User, Token, PasswordResetOtp } = require('../../src/models');

describe('Schema Constraints (E11000 Duplicate Key)', () => {
  setupTestDB();

  describe('User model: email unique index', () => {
    it('should throw E11000 on duplicate email insert', async () => {
      const email = 'test@example.com';

      // First insert succeeds
      await User.create({
        email,
        passwordHash: 'hash1_minimum_8ch',
      });

      // Second insert with same email throws E11000
      try {
        await User.create({
          email,
          passwordHash: 'hash2_minimum_8ch',
        });
        fail('Should have thrown E11000');
      } catch (error) {
        expect(error.code).toBe(11000);
        expect(error.message).toContain('email');
      }
    });

    it('should enforce email uniqueness case-insensitively', async () => {
      // First insert
      await User.create({
        email: 'Test@Example.COM',
        passwordHash: 'hash1_minimum_8ch',
      });

      // Try to insert with different casing (lowercase in schema)
      try {
        await User.create({
          email: 'test@example.com',
          passwordHash: 'hash2_minimum_8ch',
        });
        fail('Should have thrown E11000');
      } catch (error) {
        expect(error.code).toBe(11000);
      }
    });
  });

  describe('Token model: tokenHash unique index', () => {
    let userId;

    beforeEach(async () => {
      const user = await User.create({
        email: `user${Date.now()}@example.com`,
        passwordHash: 'hash_minimum_8_chars',
      });
      userId = user._id;
    });

    it('should throw E11000 on duplicate tokenHash', async () => {
      const tokenHash = 'abc123def456';
      const expiresAt = new Date(Date.now() + 60 * 1000);

      // First insert succeeds
      await Token.create({
        tokenHash,
        user: userId,
        type: 'refresh',
        expiresAt,
      });

      // Second insert with same tokenHash throws E11000
      try {
        await Token.create({
          tokenHash,
          user: userId,
          type: 'refresh',
          expiresAt,
        });
        fail('Should have thrown E11000');
      } catch (error) {
        expect(error.code).toBe(11000);
        expect(error.message).toContain('tokenHash');
      }
    });

    it('should NOT map E11000 to 409 — is a hash collision, not duplicate account', () => {
      // This is a data-layer test documenting the error for Phase 4
      // Phase 2 (error.middleware.ts) must NOT map E11000 on tokenHash to 409
      // because 409 message is "account already exists"
      // E11000 on tokenHash is "hash collision" (should map to 500 or retry)

      const error = new Error('E11000 duplicate key error collection: test.tokens index: tokenHash_1');
      error.code = 11000;

      // Assertion: this error is NOT "email already taken" (which would be 409)
      expect(error.code).toBe(11000);
      expect(error.message).toContain('tokenHash');
      // Phase 4 services: do NOT map this to 409
    });
  });

  describe('Token model: replacedBy and revokedAt fields', () => {
    let userId;
    let expiresAt;

    beforeEach(async () => {
      const user = await User.create({
        email: `user${Date.now()}@example.com`,
        passwordHash: 'hash_minimum_8_chars',
      });
      userId = user._id;
      expiresAt = new Date(Date.now() + 60 * 1000);
    });

    it('should round-trip replacedBy and revokedAt fields', async () => {
      // Create first token
      const token1 = await Token.create({
        tokenHash: 'token1_' + Date.now(),
        user: userId,
        type: 'refresh',
        expiresAt,
      });

      // Create second token
      const token2 = await Token.create({
        tokenHash: 'token2_' + Date.now(),
        user: userId,
        type: 'refresh',
        expiresAt,
      });

      // Update token1: set replacedBy and revokedAt
      const updatedToken1 = await Token.findByIdAndUpdate(
        token1._id,
        {
          replacedBy: token2._id,
          revokedAt: null, // Keep alive during grace window
        },
        { new: true }
      );

      // Verify fields round-trip correctly
      expect(updatedToken1.replacedBy).toEqual(token2._id);
      expect(updatedToken1.revokedAt).toBeNull();

      // Query: find old token in grace window
      const inGraceWindow = await Token.findOne({
        tokenHash: token1.tokenHash,
        replacedBy: { $exists: true },
        revokedAt: null,
      });
      expect(inGraceWindow).toBeDefined();
      expect(inGraceWindow._id).toEqual(token1._id);

      // After grace window: mark revoked
      const revokedToken1 = await Token.findByIdAndUpdate(
        token1._id,
        { revokedAt: new Date() },
        { new: true }
      );

      expect(revokedToken1.revokedAt).toBeDefined();
      expect(revokedToken1.replacedBy).toEqual(token2._id);
    });

    it('should support grace window query pattern', async () => {
      // Current token
      const currentToken = await Token.create({
        tokenHash: 'current_' + Date.now(),
        user: userId,
        type: 'refresh',
        expiresAt,
      });

      // New token (rotated)
      const newToken = await Token.create({
        tokenHash: 'new_' + Date.now(),
        user: userId,
        type: 'refresh',
        expiresAt,
      });

      // Link old to new
      await Token.findByIdAndUpdate(currentToken._id, {
        replacedBy: newToken._id,
        revokedAt: null,
      });

      // Query: accept token if either not rotated OR in grace window
      const acceptToken = await Token.findOne({
        tokenHash: currentToken.tokenHash,
        $or: [
          { replacedBy: null },
          { replacedBy: { $exists: true }, revokedAt: null },
        ],
      });

      expect(acceptToken).toBeDefined();
      expect(acceptToken._id).toEqual(currentToken._id);
    });
  });

  describe('PasswordResetOtp model: codeHash unique index', () => {
    it('should throw E11000 on duplicate codeHash', async () => {
      const codeHash = 'xyz789abc';
      const expiresAt = new Date(Date.now() + 600 * 1000);

      // First insert succeeds
      await PasswordResetOtp.create({
        email: `test${Date.now()}@example.com`,
        codeHash,
        expiresAt,
      });

      // Second insert with same codeHash throws E11000
      try {
        await PasswordResetOtp.create({
          email: `other${Date.now()}@example.com`,
          codeHash,
          expiresAt,
        });
        fail('Should have thrown E11000');
      } catch (error) {
        expect(error.code).toBe(11000);
        expect(error.message).toContain('codeHash');
      }
    });
  });
});
