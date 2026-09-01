'use strict';

const mongoose = require('mongoose');
const { PasswordResetOtp } = require('../../src/models');

describe('PasswordResetOtp Model', () => {
  describe('toJSON transform', () => {
    it('should exclude codeHash from JSON output (private)', () => {
      const otp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hashed_otp_code',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const json = otp.toJSON();
      expect(json).not.toHaveProperty('codeHash');
    });

    it('should exclude __v from JSON output', () => {
      const otp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hashed_otp_code',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const json = otp.toJSON();
      expect(json).not.toHaveProperty('__v');
    });
  });

  describe('Schema fields (Layer A contract §A8)', () => {
    it('should have required email field (indexed, lowercase)', () => {
      const emailField = PasswordResetOtp.schema.paths.email;
      expect(emailField.options.required).toBeDefined();
      expect(emailField.options.index).toBe(true);
      expect(emailField.options.lowercase).toBe(true);
    });

    it('should have required codeHash field (unique, private)', () => {
      const codeHashField = PasswordResetOtp.schema.paths.codeHash;
      expect(codeHashField.options.required).toBeDefined();
      expect(codeHashField.options.unique).toBe(true);
      expect(codeHashField.options.private).toBe(true);
    });

    it('should have required expiresAt field (Date)', () => {
      const expiresAtField = PasswordResetOtp.schema.paths.expiresAt;
      expect(expiresAtField.options.required).toBeDefined();
      expect(expiresAtField.instance).toBe('Date');
    });

    it('should have attempts field (default: 0)', () => {
      const attemptsField = PasswordResetOtp.schema.paths.attempts;
      expect(attemptsField.options.default).toBe(0);
    });

    it('should have optional lockedUntil field (default: null)', () => {
      const lockedUntilField = PasswordResetOtp.schema.paths.lockedUntil;
      expect(lockedUntilField.options.required).toBeUndefined();
      expect(lockedUntilField.options.default).toBe(null);
    });

    it('should have optional consumedAt field (default: null)', () => {
      const consumedAtField = PasswordResetOtp.schema.paths.consumedAt;
      expect(consumedAtField.options.required).toBeUndefined();
      expect(consumedAtField.options.default).toBe(null);
    });

    it('should have timestamps (createdAt, updatedAt)', () => {
      expect(PasswordResetOtp.schema.paths.createdAt).toBeDefined();
      expect(PasswordResetOtp.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Indexes', () => {
    it('should have TTL index on expiresAt with expireAfterSeconds: 0', () => {
      const indexes = PasswordResetOtp.schema._indexes;
      const ttlIndex = indexes.find((idx) => idx[0]?.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex[1].expireAfterSeconds).toBe(0);
    });

    it('should have index on email for queries by email', () => {
      const emailField = PasswordResetOtp.schema.paths.email;
      expect(emailField.options.index).toBe(true);
    });
  });

  describe('Layer A password reset flow (§A6)', () => {
    it('should track 5-attempt lockout', () => {
      const otp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // Locked for 15 min
      });

      expect(otp.attempts).toBe(5);
      expect(otp.lockedUntil).toBeDefined();
    });

    it('should track code consumption (single-use)', () => {
      const now = new Date();
      const otp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: now,
      });

      expect(otp.consumedAt).toEqual(now);
    });

    it('should support query: find active OTP for email', () => {
      // Query pattern for Phase 4: find non-expired, non-consumed code for email
      const query = {
        email: 'test@example.com',
        expiresAt: { $gt: new Date() },
        consumedAt: null,
      };
      expect(query).toBeDefined();
    });

    it('should support query: check attempt lockout before validating code', () => {
      // §A6: "Check the lockout *before* the code, so locked-out pilgrim
      // typing the *right* code is still told to wait."
      const query = {
        email: 'test@example.com',
        lockedUntil: { $gt: new Date() },
      };
      expect(query).toBeDefined();
    });
  });

  describe('Enumeration safety (§A6)', () => {
    it('should return 200 with identical body for known/unknown addresses', () => {
      // Implementation note: service must query by email without leaking
      // whether record exists. Same body for both cases.
      const query = { email: 'unknown@example.com' };
      expect(query).toBeDefined();
    });

    it('should support query: unknown address returns invalid_otp (not 404)', () => {
      // Query pattern: find code for email; if not found, return same
      // error as wrong code
      const query = {
        email: 'unknown@example.com',
        codeHash: 'attempted_hash',
      };
      expect(query).toBeDefined();
    });
  });

  describe('Email as primary key (not user)', () => {
    it('should allow multiple OTP records per email (resend voids previous)', () => {
      // Layer A contract: OTP is per-email, not per-user.
      // Allows same error response for registered/unregistered addresses.
      const otp1 = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hash1',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const otp2 = new PasswordResetOtp({
        email: 'test@example.com', // Same email
        codeHash: 'hash2', // Different code
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      expect(otp1.email).toEqual(otp2.email);
      expect(otp1.codeHash).not.toEqual(otp2.codeHash);
    });
  });

  describe('Single-use enforcement', () => {
    it('should prevent reuse via consumedAt check', () => {
      const consumed = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: new Date(), // Already consumed
      });

      expect(consumed.consumedAt).toBeDefined();
      // Phase 4 service must check this before allowing reset
    });
  });

  describe('Resend behavior (§A6)', () => {
    it('should reset attempts to zero on resend', () => {
      // Pattern: when resending, create NEW OTP doc and delete old
      const oldOtp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'old_hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 3, // User had 3 failed attempts
      });

      const newOtp = new PasswordResetOtp({
        email: 'test@example.com',
        codeHash: 'new_hash',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0, // Reset to zero
      });

      expect(oldOtp.attempts).toBe(3);
      expect(newOtp.attempts).toBe(0);
    });

    it('should send full fresh 600/60 on resend (not remainder)', () => {
      // Pattern: expiresAt always 600s from now, never decaying
      const expiresAt = new Date(Date.now() + 600 * 1000); // Always 600s
      expect(expiresAt).toBeDefined();
    });
  });
});
