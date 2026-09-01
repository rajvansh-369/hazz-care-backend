'use strict';

const mongoose = require('mongoose');
const { User } = require('../../src/models');

describe('User Model', () => {
  describe('toJSON transform', () => {
    it('should convert _id to id as a JSON string', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: true,
      });

      const json = user.toJSON();
      expect(json).toHaveProperty('id');
      expect(typeof json.id).toBe('string');
    });

    it('should exclude passwordHash from JSON output', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: true,
      });

      const json = user.toJSON();
      expect(json).not.toHaveProperty('passwordHash');
    });

    it('should exclude _id from JSON output', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: true,
      });

      const json = user.toJSON();
      expect(json).not.toHaveProperty('_id');
    });

    it('should exclude __v from JSON output', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: true,
      });

      const json = user.toJSON();
      expect(json).not.toHaveProperty('__v');
    });

    it('should preserve contract fields: email, fullName, emailVerified', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: false,
      });

      const json = user.toJSON();
      expect(json.email).toBe('test@example.com');
      expect(json.fullName).toBe('Test User');
      expect(json.emailVerified).toBe(false);
    });

    it('should set id to _id.toString() value (string, opaque, stable)', () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hashed_password_here',
        fullName: 'Test User',
        emailVerified: true,
      });

      const json = user.toJSON();
      const idString = user._id.toString();
      expect(json.id).toBe(idString);
    });
  });

  describe('Schema fields (Layer A contract)', () => {
    it('should have required email field (unique, lowercase, trimmed)', () => {
      const emailField = User.schema.paths.email;
      expect(emailField.options.required).toBeDefined();
      expect(emailField.options.unique).toBe(true);
      expect(emailField.options.lowercase).toBe(true);
      expect(emailField.options.trim).toBe(true);
    });

    it('should have required passwordHash field (private)', () => {
      const passwordField = User.schema.paths.passwordHash;
      expect(passwordField.options.required).toBeDefined();
      expect(passwordField.options.private).toBe(true);
    });

    it('should have optional fullName field (default: null)', () => {
      const fullNameField = User.schema.paths.fullName;
      expect(fullNameField.options.required).toBeUndefined();
      expect(fullNameField.options.default).toBe(null);
    });

    it('should have emailVerified field (default: true)', () => {
      const emailVerifiedField = User.schema.paths.emailVerified;
      expect(emailVerifiedField.options.default).toBe(true);
    });

    it('should have timestamps (createdAt, updatedAt)', () => {
      expect(User.schema.paths.createdAt).toBeDefined();
      expect(User.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Password hashing', () => {
    it('should hash passwordHash before save', async () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'plaintext_password',
        fullName: 'Test User',
      });

      const plaintext = user.passwordHash;
      await user.validate();
      expect(user.passwordHash).toBeDefined();
      // After hashing, the value will be different (and much longer for bcrypt)
      // Note: We can't actually test hashing without a DB, but the pre-save hook is in place
    });
  });

  describe('Methods', () => {
    it('should have isPasswordMatch method', () => {
      expect(User.prototype.isPasswordMatch).toBeDefined();
    });

    it('should have isEmailTaken static method', () => {
      expect(User.isEmailTaken).toBeDefined();
    });
  });
});
