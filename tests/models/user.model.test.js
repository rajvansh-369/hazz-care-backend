'use strict';

const { User } = require('../../src/models');

const newUser = (overrides = {}) =>
  new User({
    email: 'test@example.com',
    passwordHash: 'hashed_password_here',
    fullName: 'Test User',
    ...overrides,
  });

describe('User Model', () => {
  describe('serialised User (the AuthUser the client parses)', () => {
    it('has id as a non-empty string and no _id, __v or passwordHash', () => {
      const user = newUser();
      const json = JSON.parse(JSON.stringify(user));

      expect(typeof json.id).toBe('string');
      expect(json.id.trim().length).toBeGreaterThan(0);
      expect(json.id).toBe(user._id.toString());
      expect(json).not.toHaveProperty('_id');
      expect(json).not.toHaveProperty('__v');
      expect(json).not.toHaveProperty('passwordHash');
    });

    it('emits emailVerified as a real JSON boolean, defaulting to true', () => {
      const json = JSON.parse(JSON.stringify(newUser()));
      expect(json.emailVerified).toBe(true);
      expect(typeof json.emailVerified).toBe('boolean');

      const unverified = JSON.parse(JSON.stringify(newUser({ emailVerified: false })));
      expect(unverified.emailVerified).toBe(false);
    });

    it('preserves the contract fields email and fullName', () => {
      const json = newUser().toJSON();
      expect(json.email).toBe('test@example.com');
      expect(json.fullName).toBe('Test User');
    });

    it('serialises a missing fullName as null, not absent', () => {
      const json = JSON.parse(JSON.stringify(newUser({ fullName: undefined })));
      expect(json).toHaveProperty('fullName');
      expect(json.fullName).toBeNull();
    });
  });

  describe('Schema fields (Layer A contract)', () => {
    it('has a required email (unique, lowercase, trimmed)', () => {
      const emailField = User.schema.paths.email;
      expect(emailField.options.required).toBeDefined();
      expect(emailField.options.unique).toBe(true);
      expect(emailField.options.lowercase).toBe(true);
      expect(emailField.options.trim).toBe(true);
    });

    it('lowercases and trims the email on assignment', () => {
      expect(newUser({ email: '  Pilgrim@X.com ' }).email).toBe('pilgrim@x.com');
    });

    it('has a required, private passwordHash', () => {
      const passwordField = User.schema.paths.passwordHash;
      expect(passwordField.options.required).toBeDefined();
      expect(passwordField.options.private).toBe(true);
    });

    it('has an optional fullName defaulting to null', () => {
      const fullNameField = User.schema.paths.fullName;
      expect(fullNameField.options.required).toBeUndefined();
      expect(fullNameField.options.default).toBe(null);
    });

    it('has emailVerified defaulting to true', () => {
      expect(User.schema.paths.emailVerified.options.default).toBe(true);
    });

    it('has lastLoginAt (Date) defaulting to null', () => {
      const field = User.schema.paths.lastLoginAt;
      expect(field.instance).toBe('Date');
      expect(field.options.default).toBe(null);
      expect(newUser().lastLoginAt).toBeNull();
    });

    it('has timestamps (createdAt, updatedAt)', () => {
      expect(User.schema.paths.createdAt).toBeDefined();
      expect(User.schema.paths.updatedAt).toBeDefined();
    });
  });

  describe('Password hashing is not the model’s job (CLAUDE.md A11)', () => {
    it('has no pre-save hook beyond the ones Mongoose installs itself', () => {
      const mongooseBuiltins = [
        'validateBeforeSave',
        'saveSubdocsPreSave',
        'timestampsPreSave',
        'shardingPluginPreSave',
        'trackTransactionPreSave',
      ];
      const hooks = (User.schema.s.hooks._pres.get('save') || []).map((hook) => hook.fn.name);
      expect(hooks.filter((name) => !mongooseBuiltins.includes(name))).toEqual([]);
    });

    it('has no password-comparison method', () => {
      expect(User.prototype.isPasswordMatch).toBeUndefined();
    });

    it('stores passwordHash exactly as given', async () => {
      const user = newUser({ passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def' });
      await user.validate();
      expect(user.passwordHash).toBe('$argon2id$v=19$m=19456,t=2,p=1$abc$def');
    });
  });

  describe('Statics', () => {
    it('has no isEmailTaken: duplicates are detected only by the unique index (CLAUDE.md A11)', () => {
      expect(User.isEmailTaken).toBeUndefined();
    });
  });
});
