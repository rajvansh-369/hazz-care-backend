'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const setupTestDB = require('../utils/setupTestDB');
const config = require('../../src/config/config');
const logger = require('../../src/config/logger');
const { Token, User } = require('../../src/models');
const {
  createTokenService,
  hashToken,
  MAX_LIVE_CHILDREN,
} = require('../../src/services/token.service');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
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

  /** Refreshes with `raw`, fails the test on a dead token, returns the new refresh token. */
  const use = async (raw) => {
    const pair = await service.rotate(raw);
    expect(pair).not.toBeNull();
    return pair.refreshToken;
  };

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

    it('a sign-in token has no parent, is unused and has no children', async () => {
      const pair = await service.issuePair(user._id);
      const doc = await docFor(pair.refreshToken);
      expect(doc.parent).toBeNull();
      expect(doc.rotatedAt).toBeNull();
      expect(doc.childCount).toBe(0);
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
    it('the first use returns a new pair and marks the token used, not revoked', async () => {
      const first = await service.issuePair(user._id);
      const second = await service.rotate(first.refreshToken);

      expect(second).not.toBeNull();
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.expiresIn).toBe(config.jwt.accessTtlSeconds);

      const used = await docFor(first.refreshToken);
      const child = await docFor(second.refreshToken);
      expect(used.rotatedAt.getTime()).toBe(T0);
      expect(used.revokedAt).toBeNull();
      expect(used.childCount).toBe(1);
      expect(child.parent).toEqual(used._id);
      expect(child.familyId).toBe(used.familyId);
      expect(child.rotatedAt).toBeNull();

      advance(HOUR);
      await expect(service.rotate(second.refreshToken)).resolves.not.toBeNull();
    });

    it('slides the window: a child expires a full TTL after it was minted', async () => {
      const first = await service.issuePair(user._id);
      advance(10 * DAY);
      const child = await docFor(await use(first.refreshToken));
      expect(child.expiresAt.getTime()).toBe(clock + config.tokens.refreshTtlDays * DAY);
    });

    describe('a lost response: the old token keeps working while no child has been used', () => {
      it('retried hours later → a fresh pair (a sibling of the lost child)', async () => {
        const x = await service.issuePair(user._id);
        const lost = await use(x.refreshToken); // the response never reached the phone

        advance(6 * HOUR);
        const retry = await use(x.refreshToken);

        expect(retry).not.toBe(lost);
        const xDoc = await docFor(x.refreshToken);
        expect((await docFor(retry)).parent).toEqual(xDoc._id);
        expect(xDoc.childCount).toBe(2);
        expect(xDoc.revokedAt).toBeNull();
        // Both children are live: whichever the phone holds works.
        await expect(activeRefreshCount({ parent: xDoc._id })).resolves.toBe(2);
      });

      it('has no time limit: still works 59 days after it was issued', async () => {
        const x = await service.issuePair(user._id);
        await use(x.refreshToken);
        advance(59 * DAY);
        await expect(service.rotate(x.refreshToken)).resolves.not.toBeNull();
      });

      it('but not past its own expiry', async () => {
        const x = await service.issuePair(user._id);
        await use(x.refreshToken);
        advance(config.tokens.refreshTtlDays * DAY + SECOND);
        await expect(service.rotate(x.refreshToken)).resolves.toBeNull();
      });
    });

    it('the old token dies once one of its children is used, logged as reuse (R2 lands here too)', async () => {
      const x = await service.issuePair(user._id);
      const child = await use(x.refreshToken);
      const grandchild = await use(child);
      const { familyId } = await docFor(x.refreshToken);

      const warn = jest.spyOn(logger, 'warn');
      await expect(service.rotate(x.refreshToken)).resolves.toBeNull();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('family moved on'),
        expect.objectContaining({ kind: 'reuse', familyId, userId: String(user._id) })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(x.refreshToken);
      expect((await docFor(x.refreshToken)).revokedReason).toBe('SUPERSEDED');
      // Log only: the rest of the family is untouched.
      await expect(service.rotate(grandchild)).resolves.not.toBeNull();
    });

    it('the R1 race: a late response overwrote a newer token, and the device is not signed out', async () => {
      const x = await service.issuePair(user._id);
      const c1 = await use(x.refreshToken); // caller A
      const c2 = await use(x.refreshToken); // caller B, the same old token: a sibling
      const g1 = await use(c1); // A uses C1 before B has stored C2

      // C2 is a never-used sibling of the used C1: it survives that use.
      expect((await docFor(c2)).revokedAt).toBeNull();

      // B stores C2 over G1. The device's next refresh presents C2.
      const h = await use(c2);

      // That use ended the other branch.
      await expect(service.rotate(g1)).resolves.toBeNull();
      await expect(service.rotate(c1)).resolves.toBeNull();
      await expect(service.rotate(x.refreshToken)).resolves.toBeNull();
      await expect(service.rotate(h)).resolves.not.toBeNull();
    });

    it('a never-used sibling survives one use in the family and dies at the next, logged as superseded', async () => {
      const x = await service.issuePair(user._id);
      const c1 = await use(x.refreshToken);
      const c2 = await use(x.refreshToken);
      const g1 = await use(c1);
      expect((await docFor(c2)).revokedAt).toBeNull();

      await use(g1);

      const warn = jest.spyOn(logger, 'warn');
      await expect(service.rotate(c2)).resolves.toBeNull();
      expect((await docFor(c2)).revokedReason).toBe('SUPERSEDED');
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ kind: 'superseded' })
      );
    });

    it('two concurrent refreshes of one token both succeed, and every token returned stays live', async () => {
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
      // One first use and one sibling; no orphan writes from retried attempts.
      await expect(Token.countDocuments({ type: 'refresh' })).resolves.toBe(3);
      expect((await docFor(first.refreshToken)).childCount).toBe(2);
    });

    it("a child's first use racing its parent's sibling mint: the child always wins, the parent gets a pair or a 401, never an error", async () => {
      const x = await service.issuePair(user._id);
      const c1 = await use(x.refreshToken);

      const [child, parent] = await Promise.all([service.rotate(c1), service.rotate(x.refreshToken)]);

      expect(child).not.toBeNull();
      expect((await docFor(x.refreshToken)).revokedReason).toBe('SUPERSEDED');
      if (parent !== null) {
        // The sibling was minted first, so it is a never-used sibling of C1: live.
        expect((await docFor(parent.refreshToken)).revokedAt).toBeNull();
      }
    });

    it(`at ${MAX_LIVE_CHILDREN} never-used children the oldest is revoked to make room, always a pair, with a warning`, async () => {
      const x = await service.issuePair(user._id);
      const children = [];
      for (let i = 0; i < MAX_LIVE_CHILDREN; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        children.push(await use(x.refreshToken));
      }
      const xDoc = await docFor(x.refreshToken);
      await expect(activeRefreshCount({ parent: xDoc._id })).resolves.toBe(MAX_LIVE_CHILDREN);

      const warn = jest.spyOn(logger, 'warn');
      await use(x.refreshToken);

      await expect(activeRefreshCount({ parent: xDoc._id })).resolves.toBe(MAX_LIVE_CHILDREN);
      expect((await docFor(children[0])).revokedReason).toBe('SUPERSEDED');
      expect((await docFor(children[1])).revokedAt).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cap'),
        expect.objectContaining({ cap: MAX_LIVE_CHILDREN, familyId: xDoc.familyId })
      );
      await expect(service.rotate(children[0])).resolves.toBeNull();
      await expect(service.rotate(children[1])).resolves.not.toBeNull();
    });

    it('an expired token → null', async () => {
      const first = await service.issuePair(user._id);
      advance(config.tokens.refreshTtlDays * DAY + SECOND);
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

    it('a logged-out token → null, and nothing is logged as reuse', async () => {
      const first = await service.issuePair(user._id);
      await service.revokeFamily(first.refreshToken, 'LOGOUT');
      const warn = jest.spyOn(logger, 'warn');
      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    it('a logout anywhere in the family kills the used parent too', async () => {
      const x = await service.issuePair(user._id);
      const child = await use(x.refreshToken);
      await service.revokeFamily(child, 'LOGOUT');
      await expect(service.rotate(x.refreshToken)).resolves.toBeNull();
    });

    it('a password reset (revokeAllForUser) kills every token, used or not', async () => {
      const x = await service.issuePair(user._id);
      const c1 = await use(x.refreshToken);
      const c2 = await use(x.refreshToken);
      await service.revokeAllForUser(user._id, 'PASSWORD_RESET');
      advance(SECOND);
      for (const raw of [x.refreshToken, c1, c2]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(service.rotate(raw)).resolves.toBeNull();
      }
    });

    it('an unknown token → null; "" → null; non-strings → null', async () => {
      await expect(service.rotate('never-issued')).resolves.toBeNull();
      await expect(service.rotate('')).resolves.toBeNull();
      await expect(service.rotate(undefined)).resolves.toBeNull();
      await expect(service.rotate(12345)).resolves.toBeNull();
      await expect(service.rotate({ $ne: null })).resolves.toBeNull();
    });

    it('a deleted user → null, and nothing is written', async () => {
      const first = await service.issuePair(user._id);
      await User.deleteOne({ _id: user._id });

      await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
      const doc = await docFor(first.refreshToken);
      expect(doc.revokedAt).toBeNull();
      expect(doc.rotatedAt).toBeNull();
      await expect(Token.countDocuments({})).resolves.toBe(1);
    });

    it('a deleted user → null for a used token too', async () => {
      const first = await service.issuePair(user._id);
      await use(first.refreshToken);
      await User.deleteOne({ _id: user._id });
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

    it('a failure minting the child rolls the whole attempt back, and a retry works', async () => {
      const first = await service.issuePair(user._id);
      jest.spyOn(Token, 'create').mockRejectedValueOnce(new Error('disk full'));

      await expect(service.rotate(first.refreshToken)).rejects.toThrow('disk full');
      const doc = await docFor(first.refreshToken);
      expect(doc.rotatedAt).toBeNull();
      expect(doc.childCount).toBe(0);

      await expect(service.rotate(first.refreshToken)).resolves.not.toBeNull();
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

  describe('revokeFamily / revokeAllForUser', () => {
    it('revokes the presented token and every live token in its family', async () => {
      const x = await service.issuePair(user._id);
      const c1 = await use(x.refreshToken);
      const c2 = await use(x.refreshToken);
      const { familyId } = await docFor(x.refreshToken);

      await service.revokeFamily(c1, 'LOGOUT');

      await expect(activeRefreshCount({ familyId })).resolves.toBe(0);
      await expect(Token.countDocuments({ familyId, revokedReason: 'LOGOUT' })).resolves.toBe(3);
      for (const raw of [x.refreshToken, c1, c2]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(service.rotate(raw)).resolves.toBeNull();
      }
    });

    it('works from any known token: an already-revoked one still ends the family', async () => {
      const x = await service.issuePair(user._id);
      const child = await use(x.refreshToken);
      const grandchild = await use(child); // x is now revoked as SUPERSEDED

      await service.revokeFamily(x.refreshToken, 'LOGOUT');

      await expect(service.rotate(grandchild)).resolves.toBeNull();
      expect((await docFor(grandchild)).revokedReason).toBe('LOGOUT');
      expect((await docFor(x.refreshToken)).revokedReason).toBe('SUPERSEDED');
    });

    it('leaves other families and other users alone', async () => {
      const other = await User.create({ email: 'other@x.com', passwordHash: 'h' });
      const phone = await service.issuePair(user._id);
      const tablet = await service.issuePair(user._id);
      const theirs = await service.issuePair(other._id);

      await service.revokeFamily(phone.refreshToken, 'LOGOUT');

      await expect(service.rotate(tablet.refreshToken)).resolves.not.toBeNull();
      await expect(service.rotate(theirs.refreshToken)).resolves.not.toBeNull();
    });

    it('is idempotent and keeps the first reason and time', async () => {
      const pair = await service.issuePair(user._id);
      await service.revokeFamily(pair.refreshToken, 'LOGOUT');
      const first = await docFor(pair.refreshToken);

      advance(SECOND);
      await service.revokeFamily(pair.refreshToken, 'ADMIN');
      const second = await docFor(pair.refreshToken);

      expect(second.revokedReason).toBe('LOGOUT');
      expect(second.revokedAt).toEqual(first.revokedAt);
    });

    it('of unknown, empty or non-string tokens is a no-op', async () => {
      await service.issuePair(user._id);
      await expect(service.revokeFamily('never-issued')).resolves.toBeUndefined();
      await expect(service.revokeFamily('')).resolves.toBeUndefined();
      await expect(service.revokeFamily(null)).resolves.toBeUndefined();
      await expect(activeRefreshCount()).resolves.toBe(1);
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
