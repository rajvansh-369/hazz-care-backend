'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const setupTestDB = require('../utils/setupTestDB');
const config = require('../../src/config/config');
const { Token, User } = require('../../src/models');
const { createTokenService, hashToken } = require('../../src/services/token.service');

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const T0 = new Date('2026-09-24T12:00:00.000Z').getTime();

describe('token.service', () => {
  setupTestDB();

  let clock;
  let service;
  let user;

  const advance = (ms) => {
    clock += ms;
  };
  const activeRefreshCount = (filter = {}) =>
    Token.countDocuments({ type: 'refresh', revokedAt: null, ...filter });
  const docFor = (raw) => Token.findOne({ tokenHash: hashToken(raw) }).lean();

  beforeAll(async () => {
    await Promise.all([Token.createCollection(), User.createCollection()]);
    await Token.init();
  });

  beforeEach(async () => {
    clock = T0;
    service = createTokenService({ now: () => new Date(clock) });
    user = await User.create({ email: 'pilgrim@x.com', passwordHash: '$argon2id$placeholder' });
  });

  describe('issuePair', () => {
    it('stores only the sha256 of the refresh token; the raw token is in no field', async () => {
      const pair = await service.issuePair(user._id);
      const docs = await Token.find({}).lean();

      expect(docs).toHaveLength(1);
      expect(docs[0].tokenHash).toBe(
        crypto.createHash('sha256').update(pair.refreshToken).digest('hex')
      );
      expect(JSON.stringify(docs)).not.toContain(pair.refreshToken);
    });

    it('sets purgeAt = expiresAt + 7 days and expiresAt = now + refresh TTL', async () => {
      const pair = await service.issuePair(user._id);
      const doc = await docFor(pair.refreshToken);
      expect(doc.expiresAt.getTime()).toBe(T0 + config.tokens.refreshTtlDays * DAY);
      expect(doc.purgeAt.getTime() - doc.expiresAt.getTime()).toBe(7 * DAY);
      expect(doc.type).toBe('refresh');
      expect(typeof doc.familyId).toBe('string');
    });

    it('returns expiresIn as a number equal to ACCESS_TOKEN_TTL_SECONDS', async () => {
      const pair = await service.issuePair(user._id);
      expect(typeof pair.expiresIn).toBe('number');
      expect(pair.expiresIn).toBe(config.jwt.accessTtlSeconds);
      expect(Object.keys(pair).sort()).toEqual(['accessToken', 'expiresIn', 'refreshToken']);
    });

    it('signs an HS256 access token with sub, sid (the family) and jti', async () => {
      const pair = await service.issuePair(user._id, { familyId: 'fam-1' });
      const decoded = jwt.decode(pair.accessToken, { complete: true });
      expect(decoded.header.alg).toBe('HS256');
      expect(decoded.payload.sub).toBe(String(user._id));
      expect(decoded.payload.sid).toBe('fam-1');
      expect(typeof decoded.payload.jti).toBe('string');
      expect(decoded.payload.exp - decoded.payload.iat).toBe(config.jwt.accessTtlSeconds);
    });

    it('writes inside a caller-supplied session', async () => {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await service.issuePair(user._id, { session });
          await session.abortTransaction();
        });
      } finally {
        await session.endSession();
      }
      await expect(Token.countDocuments({})).resolves.toBe(0);
    });
  });

  describe('rotate', () => {
    it('returns a new pair, and the new refresh token rotates in turn', async () => {
      const first = await service.issuePair(user._id);
      const second = await service.rotate(first.refreshToken);

      expect(second).not.toBeNull();
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.expiresIn).toBe(config.jwt.accessTtlSeconds);

      const old = await docFor(first.refreshToken);
      const successor = await docFor(second.refreshToken);
      expect(old.revokedReason).toBe('ROTATED');
      expect(old.rotatedAt.getTime()).toBe(T0);
      expect(old.replacedBy).toEqual(successor._id);
      expect(successor.familyId).toBe(old.familyId);

      advance(3600 * SECOND);
      const third = await service.rotate(second.refreshToken);
      expect(third).not.toBeNull();
    });

    it('slides the window: the successor expires a full TTL after the rotation', async () => {
      const first = await service.issuePair(user._id);
      advance(10 * DAY);
      const second = await service.rotate(first.refreshToken);
      const successor = await docFor(second.refreshToken);
      expect(successor.expiresAt.getTime()).toBe(clock + config.tokens.refreshTtlDays * DAY);
    });

    it('the OLD token at +1s returns a fresh pair, and the first successor still rotates', async () => {
      const first = await service.issuePair(user._id);
      const successor = await service.rotate(first.refreshToken);

      advance(1 * SECOND);
      const retry = await service.rotate(first.refreshToken);
      expect(retry).not.toBeNull();
      expect(retry.refreshToken).not.toBe(successor.refreshToken);
      expect((await docFor(retry.refreshToken)).familyId).toBe(
        (await docFor(first.refreshToken)).familyId
      );

      await expect(service.rotate(successor.refreshToken)).resolves.not.toBeNull();
      await expect(service.rotate(retry.refreshToken)).resolves.not.toBeNull();
    });

    it('the old token at exactly +60s is still inside the window', async () => {
      const first = await service.issuePair(user._id);
      await service.rotate(first.refreshToken);
      advance(60 * SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.not.toBeNull();
    });

    it('the old token at +61s → null, and the family is NOT revoked', async () => {
      const first = await service.issuePair(user._id);
      const successor = await service.rotate(first.refreshToken);
      const { familyId } = await docFor(first.refreshToken);

      advance(61 * SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();

      const successorDoc = await docFor(successor.refreshToken);
      expect(successorDoc.revokedAt).toBeNull();
      await expect(activeRefreshCount({ familyId })).resolves.toBe(1);
      await expect(service.rotate(successor.refreshToken)).resolves.not.toBeNull();
    });

    it('two concurrent rotations of one active token both succeed, and every token returned stays active', async () => {
      const first = await service.issuePair(user._id);

      const results = await Promise.all([
        service.rotate(first.refreshToken),
        service.rotate(first.refreshToken),
      ]);

      expect(results[0]).not.toBeNull();
      expect(results[1]).not.toBeNull();
      expect(results[0].refreshToken).not.toBe(results[1].refreshToken);

      const returned = await Promise.all(results.map((pair) => docFor(pair.refreshToken)));
      returned.forEach((doc) => {
        expect(doc).not.toBeNull();
        expect(doc.revokedAt).toBeNull();
      });
      // Exactly one claim happened: one successor linked, no orphan writes from retries.
      await expect(Token.countDocuments({ type: 'refresh' })).resolves.toBe(3);
      await expect(activeRefreshCount()).resolves.toBe(2);
    });

    it('an expired token → null', async () => {
      const first = await service.issuePair(user._id);
      advance(config.tokens.refreshTtlDays * DAY + SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('a LOGOUT-revoked token → null', async () => {
      const first = await service.issuePair(user._id);
      await service.revoke(first.refreshToken, 'LOGOUT');
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('an unknown token → null; "" → null; non-strings → null', async () => {
      await expect(service.rotate('never-issued')).resolves.toBeNull();
      await expect(service.rotate('')).resolves.toBeNull();
      await expect(service.rotate(undefined)).resolves.toBeNull();
      await expect(service.rotate(12345)).resolves.toBeNull();
      await expect(service.rotate({ $ne: null })).resolves.toBeNull();
    });

    it('a deleted user → null, and the claim is rolled back', async () => {
      const first = await service.issuePair(user._id);
      await User.deleteOne({ _id: user._id });

      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
      const doc = await docFor(first.refreshToken);
      expect(doc.revokedAt).toBeNull();
      await expect(Token.countDocuments({})).resolves.toBe(1);
    });

    it('a deleted user → null inside the grace window too', async () => {
      const first = await service.issuePair(user._id);
      await service.rotate(first.refreshToken);
      await User.deleteOne({ _id: user._id });
      advance(SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('a logout of the successor ends the grace window for the old token', async () => {
      const first = await service.issuePair(user._id);
      const successor = await service.rotate(first.refreshToken);
      await service.revoke(successor.refreshToken, 'LOGOUT');
      advance(SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('a password reset (revokeAllForUser) ends the grace window for the old token', async () => {
      const first = await service.issuePair(user._id);
      await service.rotate(first.refreshToken);
      await service.revokeAllForUser(user._id, 'PASSWORD_RESET');
      advance(SECOND);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('a token issued at t0 still rotates at t0 + 59 days', async () => {
      const first = await service.issuePair(user._id);
      advance(59 * DAY);
      await expect(service.rotate(first.refreshToken)).resolves.not.toBeNull();
    });

    it('a token issued at t0 is dead at t0 + 61 days', async () => {
      const first = await service.issuePair(user._id);
      advance(61 * DAY);
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    });

    it('a database failure throws; it never returns null', async () => {
      const first = await service.issuePair(user._id);
      jest.spyOn(Token, 'findOneAndUpdate').mockRejectedValue(new Error('connection reset'));

      await expect(service.rotate(first.refreshToken)).rejects.toThrow('connection reset');
    });

    it('a failure in the user lookup throws too', async () => {
      const first = await service.issuePair(user._id);
      jest.spyOn(User, 'exists').mockImplementation(() => {
        throw new Error('primary stepped down');
      });

      await expect(service.rotate(first.refreshToken)).rejects.toThrow('primary stepped down');
      expect((await docFor(first.refreshToken)).revokedAt).toBeNull();
    });
  });

  describe('verifyAccess', () => {
    const secret = config.jwt.accessSecret;

    it('valid → { userId }', async () => {
      const { accessToken } = await service.issuePair(user._id);
      expect(service.verifyAccess(accessToken)).toEqual({ userId: String(user._id) });
    });

    it('valid until the TTL, expired after it', async () => {
      const { accessToken } = await service.issuePair(user._id);
      advance((config.jwt.accessTtlSeconds - 1) * SECOND);
      expect(service.verifyAccess(accessToken)).not.toBeNull();
      advance(2 * SECOND);
      expect(service.verifyAccess(accessToken)).toBeNull();
    });

    it('wrong secret → null', () => {
      const token = jwt.sign({ sub: 'u1' }, 'another-secret-that-is-long-enough-000000', {
        algorithm: 'HS256',
      });
      expect(service.verifyAccess(token)).toBeNull();
    });

    it('alg "none" → null', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url'
      );
      const payload = Buffer.from(
        JSON.stringify({ sub: 'u1', exp: Math.floor(clock / 1000) + 600 })
      ).toString('base64url');
      expect(service.verifyAccess(`${header}.${payload}.`)).toBeNull();
    });

    it('a different HMAC algorithm (HS512) with the right secret → null', () => {
      const token = jwt.sign({ sub: 'u1' }, secret, { algorithm: 'HS512' });
      expect(service.verifyAccess(token)).toBeNull();
    });

    it('missing sub → null; empty sub → null; non-string sub → null', () => {
      const iat = Math.floor(clock / 1000);
      const sign = (payload) =>
        jwt.sign({ iat, exp: iat + 600, ...payload }, secret, { algorithm: 'HS256' });
      expect(service.verifyAccess(sign({}))).toBeNull();
      expect(service.verifyAccess(sign({ sub: '  ' }))).toBeNull();
      expect(service.verifyAccess(sign({ sub: 42 }))).toBeNull();
    });

    it('garbage and non-strings → null', () => {
      expect(service.verifyAccess('not.a.jwt')).toBeNull();
      expect(service.verifyAccess('')).toBeNull();
      expect(service.verifyAccess(undefined)).toBeNull();
    });
  });

  describe('revoke / revokeAllForUser', () => {
    it('revoke is idempotent and keeps the first reason and time', async () => {
      const pair = await service.issuePair(user._id);
      await service.revoke(pair.refreshToken, 'LOGOUT');
      const first = await docFor(pair.refreshToken);

      advance(SECOND);
      await service.revoke(pair.refreshToken, 'ADMIN');
      const second = await docFor(pair.refreshToken);

      expect(second.revokedReason).toBe('LOGOUT');
      expect(second.revokedAt).toEqual(first.revokedAt);
    });

    it('revoke of unknown, empty or non-string tokens is a no-op', async () => {
      await expect(service.revoke('never-issued')).resolves.toBeUndefined();
      await expect(service.revoke('')).resolves.toBeUndefined();
      await expect(service.revoke(null)).resolves.toBeUndefined();
    });

    it('revokeAllForUser revokes every active refresh token of that user only', async () => {
      const other = await User.create({ email: 'other@x.com', passwordHash: 'h' });
      await service.issuePair(user._id);
      await service.issuePair(user._id);
      const otherPair = await service.issuePair(other._id);
      const reset = await service.issueResetToken(user._id);

      await service.revokeAllForUser(user._id, 'PASSWORD_RESET');

      await expect(activeRefreshCount({ user: user._id })).resolves.toBe(0);
      await expect(
        Token.countDocuments({ user: user._id, revokedReason: 'PASSWORD_RESET' })
      ).resolves.toBe(2);
      await expect(activeRefreshCount({ user: other._id })).resolves.toBe(1);
      await expect(service.rotate(otherPair.refreshToken)).resolves.not.toBeNull();
      expect(await service.findUsableResetToken(reset)).not.toBeNull();
    });
  });

  describe('reset tokens', () => {
    it('issues an "rst_" token, stores only its hash, purgeAt = expiresAt + 24h', async () => {
      const raw = await service.issueResetToken(user._id);
      expect(raw.startsWith('rst_')).toBe(true);

      const docs = await Token.find({}).lean();
      expect(docs).toHaveLength(1);
      expect(docs[0].type).toBe('resetPassword');
      expect(docs[0].tokenHash).toBe(hashToken(raw));
      expect(JSON.stringify(docs)).not.toContain(raw);
      expect(docs[0].expiresAt.getTime()).toBe(T0 + config.tokens.resetTtlSeconds * SECOND);
      expect(docs[0].purgeAt.getTime() - docs[0].expiresAt.getTime()).toBe(DAY);
      expect(docs[0].consumedAt).toBeNull();
    });

    it('findUsable finds it, and is read-only', async () => {
      const raw = await service.issueResetToken(user._id);
      const found = await service.findUsableResetToken(raw);
      expect(String(found.user)).toBe(String(user._id));
      expect((await docFor(raw)).consumedAt).toBeNull();
    });

    it('consume works once and returns null the second time', async () => {
      const raw = await service.issueResetToken(user._id);
      const consumed = await service.consumeResetToken(raw);
      expect(consumed.consumedAt.getTime()).toBe(T0);
      await expect(service.consumeResetToken(raw)).resolves.toBeNull();
      await expect(service.findUsableResetToken(raw)).resolves.toBeNull();
    });

    it('two concurrent consumes → exactly one succeeds', async () => {
      const raw = await service.issueResetToken(user._id);
      const results = await Promise.all([
        service.consumeResetToken(raw),
        service.consumeResetToken(raw),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('an expired reset token is neither found nor consumed', async () => {
      const raw = await service.issueResetToken(user._id);
      advance(config.tokens.resetTtlSeconds * SECOND + SECOND);
      await expect(service.findUsableResetToken(raw)).resolves.toBeNull();
      await expect(service.consumeResetToken(raw)).resolves.toBeNull();
    });

    it('a reset token is not a refresh token', async () => {
      const raw = await service.issueResetToken(user._id);
      await expect(service.rotate(raw)).resolves.toBeNull();
      expect(service.verifyAccess(raw)).toBeNull();
    });

    it('a refresh token is not a reset token', async () => {
      const pair = await service.issuePair(user._id);
      await expect(service.findUsableResetToken(pair.refreshToken)).resolves.toBeNull();
      await expect(service.consumeResetToken(pair.refreshToken)).resolves.toBeNull();
    });

    it('invalidateResetTokensForUser consumes every open reset token of that user only', async () => {
      const other = await User.create({ email: 'other@x.com', passwordHash: 'h' });
      const a = await service.issueResetToken(user._id);
      const b = await service.issueResetToken(user._id);
      const theirs = await service.issueResetToken(other._id);

      await service.invalidateResetTokensForUser(user._id);

      await expect(service.findUsableResetToken(a)).resolves.toBeNull();
      await expect(service.findUsableResetToken(b)).resolves.toBeNull();
      expect(await service.findUsableResetToken(theirs)).not.toBeNull();
    });
  });

  describe('default instance', () => {
    it('is built with the real clock', async () => {
      // eslint-disable-next-line global-require
      const defaultService = require('../../src/services/token.service');
      const pair = await defaultService.issuePair(user._id);
      const doc = await docFor(pair.refreshToken);
      expect(Math.abs(doc.expiresAt.getTime() - (Date.now() + config.tokens.refreshTtlDays * DAY))).toBeLessThan(
        60 * SECOND
      );
    });
  });
});
