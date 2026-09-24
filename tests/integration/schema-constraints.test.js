'use strict';

const mongoose = require('mongoose');
const setupTestDB = require('../utils/setupTestDB');
const models = require('../../src/models');
const { syncAllIndexes } = require('../../scripts/sync-indexes');

const {
  User,
  Token,
  PasswordResetOtp,
  RevenueCatEvent,
  Entitlement,
  RateLimit,
  AliasLink,
} = models;

const DAY_MS = 24 * 60 * 60 * 1000;

const createUser = (email = 'pilgrim@x.com') =>
  User.create({ email, passwordHash: '$argon2id$placeholder' });

const tokenFields = (userId, overrides = {}) => {
  const expiresAt = new Date(Date.now() + 60 * DAY_MS);
  return {
    tokenHash: `hash-${new mongoose.Types.ObjectId()}`,
    user: userId,
    type: 'refresh',
    familyId: 'family-1',
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 7 * DAY_MS),
    ...overrides,
  };
};

const otpFields = (userId, overrides = {}) => {
  const expiresAt = new Date(Date.now() + 600 * 1000);
  return {
    email: 'pilgrim@x.com',
    user: userId,
    codeHash: 'hmac-of-123456',
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + DAY_MS),
    ...overrides,
  };
};

/** Indexes as MongoDB actually has them, keyed by the index's field list. */
const indexesOn = async (model) => model.collection.indexes();
const ttlIndexOn = (indexes, field) =>
  indexes.find((index) => index.key[field] === 1 && index.expireAfterSeconds !== undefined);

describe('Schema constraints against a real MongoDB', () => {
  setupTestDB();

  // Build every declared index before asserting on it (autoIndex is asynchronous).
  beforeAll(async () => {
    await syncAllIndexes(models);
  });

  describe('User: email unique index', () => {
    it('throws E11000 on a duplicate email', async () => {
      await createUser('test@example.com');
      await expect(createUser('test@example.com')).rejects.toMatchObject({ code: 11000 });
    });

    it('throws E11000 for "Pilgrim@X.com" after "pilgrim@x.com" (lowercased before insert)', async () => {
      await createUser('pilgrim@x.com');
      const error = await createUser('Pilgrim@X.com').catch((e) => e);
      expect(error.code).toBe(11000);
      expect(error.message).toContain('email');
    });

    it('stores passwordHash exactly as given: no hook re-hashes it on save or update', async () => {
      const user = await createUser();
      user.fullName = 'Renamed';
      await user.save();
      const fresh = await User.findById(user._id).select('+passwordHash').lean();
      expect(fresh.passwordHash).toBe('$argon2id$placeholder');
    });

    it('serialises a stored user with id as the string form of _id', async () => {
      const user = await createUser();
      const json = JSON.parse(JSON.stringify(await User.findById(user._id)));
      expect(json.id).toBe(user._id.toString());
      expect(json).not.toHaveProperty('_id');
      expect(json).not.toHaveProperty('passwordHash');
      expect(json.emailVerified).toBe(true);
    });
  });

  describe('Token', () => {
    let userId;

    beforeEach(async () => {
      userId = (await createUser())._id;
    });

    it('throws E11000 on a duplicate tokenHash', async () => {
      await Token.create(tokenFields(userId, { tokenHash: 'same' }));
      const error = await Token.create(tokenFields(userId, { tokenHash: 'same' })).catch((e) => e);
      expect(error.code).toBe(11000);
      expect(error.message).toContain('tokenHash');
    });

    it('round-trips the rotation fields used by the grace window', async () => {
      const oldToken = await Token.create(tokenFields(userId));
      const newToken = await Token.create(tokenFields(userId));
      const rotatedAt = new Date();

      await Token.updateOne(
        { _id: oldToken._id, rotatedAt: null },
        { replacedBy: newToken._id, rotatedAt }
      );

      const stored = await Token.findById(oldToken._id).lean();
      expect(stored.replacedBy).toEqual(newToken._id);
      expect(stored.rotatedAt).toEqual(rotatedAt);
      expect(stored.revokedAt).toBeNull();
      expect(stored.revokedReason).toBeNull();
      expect(stored.consumedAt).toBeNull();
    });
  });

  describe('PasswordResetOtp: codeHash is NOT unique', () => {
    it('inserts two OTP documents with the same codeHash', async () => {
      const a = await createUser('a@example.com');
      const b = await createUser('b@example.com');

      await PasswordResetOtp.create(otpFields(a._id, { email: 'a@example.com' }));
      await PasswordResetOtp.create(otpFields(b._id, { email: 'b@example.com' }));

      await expect(PasswordResetOtp.countDocuments({ codeHash: 'hmac-of-123456' })).resolves.toBe(
        2
      );
    });

    it('has no unique index on codeHash in the database', async () => {
      const indexes = await indexesOn(PasswordResetOtp);
      expect(indexes.filter((index) => 'codeHash' in index.key)).toEqual([]);
    });
  });

  describe('Idempotency and uniqueness keys', () => {
    it('rejects a duplicate RevenueCatEvent _id (a RevenueCat retry)', async () => {
      const event = {
        _id: 'rc_event_1',
        type: 'NON_RENEWING_PURCHASE',
        appUserId: 'user123',
        rawBody: '{"event":{"id":"rc_event_1"}}',
      };
      await RevenueCatEvent.create(event);
      await expect(RevenueCatEvent.create(event)).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a second Entitlement for the same user', async () => {
      const user = await createUser();
      await Entitlement.create({ user: user._id, entitlementId: 'hajjcare_pass' });
      await expect(
        Entitlement.create({ user: user._id, entitlementId: 'hajjcare_pass' })
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a duplicate RateLimit key', async () => {
      const doc = { key: 'otp-send:abc:2026092412', purgeAt: new Date(Date.now() + DAY_MS) };
      await RateLimit.create(doc);
      await expect(RateLimit.create(doc)).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a duplicate AliasLink alias', async () => {
      await AliasLink.create({ alias: '$RCAnonymousID:abc' });
      await expect(AliasLink.create({ alias: '$RCAnonymousID:abc' })).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('creates an AliasLink with user null until the alias is resolved', async () => {
      const link = await AliasLink.create({ alias: '$RCAnonymousID:def' });
      expect(link.user).toBeNull();
    });
  });

  describe('TTL indexes are on purgeAt, never on expiresAt', () => {
    it.each([
      ['Token', Token],
      ['PasswordResetOtp', PasswordResetOtp],
    ])('%s: TTL on purgeAt, nothing on expiresAt', async (_name, model) => {
      const indexes = await indexesOn(model);
      const ttl = ttlIndexOn(indexes, 'purgeAt');
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBe(0);
      expect(indexes.filter((index) => 'expiresAt' in index.key)).toEqual([]);
    });

    it('RateLimit: TTL on purgeAt', async () => {
      const ttl = ttlIndexOn(await indexesOn(RateLimit), 'purgeAt');
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBe(0);
    });
  });

  describe('sync-indexes', () => {
    it('drops a stale unique codeHash index and a stale expiresAt TTL left by an old schema', async () => {
      const { collectionName } = PasswordResetOtp.collection;
      await mongoose.connection.db.dropCollection(collectionName).catch(() => null);
      const raw = await mongoose.connection.db.createCollection(collectionName);
      await raw.createIndex({ codeHash: 1 }, { unique: true, name: 'codeHash_1' });
      await raw.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' });

      const [result] = await syncAllIndexes({ PasswordResetOtp });

      expect(result.dropped).toEqual(expect.arrayContaining(['codeHash_1', 'expiresAt_1']));
      expect(result.created).toEqual(expect.arrayContaining(['purgeAt_1']));
      const names = (await raw.indexes()).map((index) => index.name);
      expect(names).not.toContain('codeHash_1');
      expect(names).not.toContain('expiresAt_1');
      expect(names).toContain('purgeAt_1');
    });
  });
});
