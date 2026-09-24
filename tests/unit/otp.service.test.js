'use strict';

const crypto = require('crypto');
const setupTestDB = require('../utils/setupTestDB');
const config = require('../../src/config/config');
const { PasswordResetOtp, User } = require('../../src/models');
const { createOtpService, hashCode } = require('../../src/services/otp.service');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const T0 = new Date('2026-09-24T12:00:00.000Z').getTime();

describe('otp.service', () => {
  setupTestDB();

  let clock;
  let service;
  let user;

  const advance = (ms) => {
    clock += ms;
  };
  const otherCode = (code) => (code === '000000' ? '000001' : '000000');
  const activeDoc = (email = user.email) =>
    PasswordResetOtp.findOne({ email, consumedAt: null, supersededAt: null })
      .sort({ createdAt: -1 })
      .lean();

  beforeAll(async () => {
    await Promise.all([PasswordResetOtp.createCollection(), User.createCollection()]);
  });

  beforeEach(async () => {
    clock = T0;
    service = createOtpService({ now: () => new Date(clock) });
    user = await User.create({ email: 'pilgrim@x.com', passwordHash: 'h' });
  });

  describe('generateCode', () => {
    it('produces 6 ASCII digits, zero-padded', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(service.generateCode()).toMatch(/^[0-9]{6}$/);
      }
      jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(42);
      expect(service.generateCode()).toBe('000042');
    });
  });

  describe('issue', () => {
    it('stores an HMAC bound to the user, never the code or its plain sha256', async () => {
      const { code } = await service.issue(user);
      expect(code).toMatch(/^[0-9]{6}$/);

      const doc = await activeDoc();
      const plainSha = crypto.createHash('sha256').update(code).digest('hex');
      expect(doc.codeHash).toBe(
        crypto.createHmac('sha256', config.otp.hmacSecret).update(`${user._id}:${code}`).digest('hex')
      );
      expect(doc.codeHash).toBe(hashCode(String(user._id), code));
      expect(doc.codeHash).not.toBe(plainSha);
      Object.values(doc).forEach((value) => expect(value).not.toBe(code));
      expect(JSON.stringify(doc)).not.toContain(`"${code}"`);
    });

    it('sets expiresAt = now + 600s, purgeAt = expiresAt + 24h, attempts 0, user and email', async () => {
      await service.issue({ _id: user._id, email: '  Pilgrim@X.com ' });
      const doc = await activeDoc();
      expect(doc.email).toBe('pilgrim@x.com');
      expect(String(doc.user)).toBe(String(user._id));
      expect(doc.expiresAt.getTime()).toBe(T0 + config.otp.ttlSeconds * SECOND);
      expect(config.otp.ttlSeconds).toBe(600);
      expect(doc.purgeAt.getTime() - doc.expiresAt.getTime()).toBe(24 * HOUR);
      expect(doc.attempts).toBe(0);
      expect(doc.consumedAt).toBeNull();
      expect(doc.supersededAt).toBeNull();
    });

    it('two issues in a row: only the newest code works', async () => {
      const first = await service.issue(user);
      const second = await service.issue(user);

      if (first.code !== second.code) {
        await expect(service.verify(user.email, first.code)).resolves.toEqual({ error: 'invalid' });
      }
      await expect(service.verify(user.email, second.code)).resolves.toEqual({
        ok: true,
        userId: String(user._id),
      });
      await expect(PasswordResetOtp.countDocuments({ supersededAt: { $ne: null } })).resolves.toBe(
        1
      );
    });
  });

  describe('verify', () => {
    it('the right code → ok with the right userId; the same code again → invalid', async () => {
      const { code } = await service.issue(user);
      await expect(service.verify('pilgrim@x.com', code)).resolves.toEqual({
        ok: true,
        userId: String(user._id),
      });
      await expect(service.verify('pilgrim@x.com', code)).resolves.toEqual({ error: 'invalid' });
    });

    it('matches the address case-insensitively and trimmed', async () => {
      const { code } = await service.issue(user);
      await expect(service.verify('  PILGRIM@x.com ', code)).resolves.toMatchObject({ ok: true });
    });

    it('a wrong code → invalid and charges one attempt', async () => {
      const { code } = await service.issue(user);
      await expect(service.verify(user.email, otherCode(code))).resolves.toEqual({
        error: 'invalid',
      });
      expect((await activeDoc()).attempts).toBe(1);
    });

    it('5 wrong attempts, then the RIGHT code → locked (lockout checked before the code)', async () => {
      const { code } = await service.issue(user);
      for (let i = 0; i < config.otp.maxAttempts; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await expect(service.verify(user.email, otherCode(code))).resolves.toEqual({
          error: 'invalid',
        });
      }
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'locked' });
      expect((await activeDoc()).attempts).toBe(5);
    });

    it('an expired code → expired, and attempts are unchanged', async () => {
      const { code } = await service.issue(user);
      await service.verify(user.email, otherCode(code));
      advance(config.otp.ttlSeconds * SECOND);

      await expect(service.verify(user.email, otherCode(code))).resolves.toEqual({
        error: 'expired',
      });
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'expired' });
      expect((await activeDoc()).attempts).toBe(1);
    });

    it('one second before expiry the right code still works', async () => {
      const { code } = await service.issue(user);
      advance(config.otp.ttlSeconds * SECOND - SECOND);
      await expect(service.verify(user.email, code)).resolves.toMatchObject({ ok: true });
    });

    it('locked takes precedence over expired', async () => {
      const { code } = await service.issue(user);
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await service.verify(user.email, otherCode(code));
      }
      advance(config.otp.ttlSeconds * SECOND + SECOND);
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'locked' });
    });

    it('issue() after a lockout: the new code works, attempts 0, the old code → invalid', async () => {
      const old = await service.issue(user);
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await service.verify(user.email, otherCode(old.code));
      }
      await expect(service.verify(user.email, old.code)).resolves.toEqual({ error: 'locked' });

      jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(Number(otherCode(old.code)));
      const fresh = await service.issue(user);
      expect((await activeDoc()).attempts).toBe(0);

      await expect(service.verify(user.email, old.code)).resolves.toEqual({ error: 'invalid' });
      await expect(service.verify(user.email, fresh.code)).resolves.toMatchObject({ ok: true });
    });

    it('an unknown email → invalid', async () => {
      await expect(service.verify('nobody@x.com', '123456')).resolves.toEqual({ error: 'invalid' });
    });

    it('an address with no active code → invalid', async () => {
      const { code } = await service.issue(user);
      await service.verify(user.email, code);
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'invalid' });
    });

    it.each([
      ['a number', 123456],
      ['null', null],
      ['an empty string', ''],
      ['Arabic-Indic digits', '١٢٣٤٥٦'],
    ])('a code that is %s → invalid and charged', async (_label, code) => {
      await service.issue(user);
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'invalid' });
      expect((await activeDoc()).attempts).toBe(1);
    });

    it('a non-string email → invalid', async () => {
      await expect(service.verify(undefined, '123456')).resolves.toEqual({ error: 'invalid' });
    });

    it('20 parallel wrong guesses: at most 5 invalid, the rest locked, attempts never above 5', async () => {
      const { code } = await service.issue(user);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.verify(user.email, otherCode(code)))
      );
      const invalid = results.filter((r) => r.error === 'invalid').length;
      const locked = results.filter((r) => r.error === 'locked').length;

      expect(invalid).toBeLessThanOrEqual(5);
      expect(invalid + locked).toBe(20);
      expect((await activeDoc()).attempts).toBe(5);
      await expect(service.verify(user.email, code)).resolves.toEqual({ error: 'locked' });
    });

    it('two parallel verifies with the right code → exactly one ok', async () => {
      const { code } = await service.issue(user);
      const results = await Promise.all([
        service.verify(user.email, code),
        service.verify(user.email, code),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.error === 'invalid')).toHaveLength(1);
    });

    it('two users can hold the same code at once, and each verifies only for their own email', async () => {
      const other = await User.create({ email: 'other@x.com', passwordHash: 'h' });
      jest.spyOn(crypto, 'randomInt').mockReturnValue(314159);

      const mine = await service.issue(user);
      const theirs = await service.issue(other);
      expect(mine.code).toBe('314159');
      expect(theirs.code).toBe('314159');

      await expect(service.verify('other@x.com', '314159')).resolves.toEqual({
        ok: true,
        userId: String(other._id),
      });
      await expect(service.verify('pilgrim@x.com', '314159')).resolves.toEqual({
        ok: true,
        userId: String(user._id),
      });
    });

    it("a code issued for one address never verifies for another's", async () => {
      await User.create({ email: 'other@x.com', passwordHash: 'h' });
      const { code } = await service.issue(user);
      await expect(service.verify('other@x.com', code)).resolves.toEqual({ error: 'invalid' });
    });

    it('a database failure throws; it is never reported as a code result', async () => {
      await service.issue(user);
      jest.spyOn(PasswordResetOtp, 'findOne').mockImplementationOnce(() => {
        throw new Error('connection reset');
      });
      await expect(service.verify(user.email, '123456')).rejects.toThrow('connection reset');
    });
  });

  describe('supersedeAllForUser', () => {
    it('voids every active code for that user only', async () => {
      const other = await User.create({ email: 'other@x.com', passwordHash: 'h' });
      const mine = await service.issue(user);
      const theirs = await service.issue(other);

      await service.supersedeAllForUser(user._id);

      await expect(service.verify(user.email, mine.code)).resolves.toEqual({ error: 'invalid' });
      await expect(service.verify(other.email, theirs.code)).resolves.toMatchObject({ ok: true });
    });
  });
});
