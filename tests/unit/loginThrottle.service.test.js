'use strict';

const setupTestDB = require('../utils/setupTestDB');
const logger = require('../../src/config/logger');
const { RateLimit, User } = require('../../src/models');
const {
  createLoginThrottleService,
  delayAfter,
  WINDOW_MS,
  MAX_DELAY_MS,
} = require('../../src/services/loginThrottle.service');

const T0 = new Date('2026-09-27T12:02:00.000Z').getTime();
const BUCKET = Math.floor(T0 / WINDOW_MS);

// Attempts 1–5 wait nothing; then 1s, 2s, 4s, and 5s from then on.
const TWELVE = [0, 0, 0, 0, 0, 1000, 2000, 4000, 5000, 5000, 5000, 5000];

describe('loginThrottle.service', () => {
  setupTestDB();

  let clock;
  let slept;
  let service;

  const attempts = async (email, times) => {
    for (let i = 0; i < times; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.beforeAttempt(email);
    }
  };

  beforeAll(async () => {
    await RateLimit.createCollection();
    await RateLimit.init();
  });

  beforeEach(() => {
    clock = T0;
    slept = [];
    service = createLoginThrottleService({
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
  });

  describe('delayAfter', () => {
    it('nothing for the first five failures, then 1s, 2s, 4s, capped at 5s', () => {
      expect(Array.from({ length: 12 }, (_, failures) => delayAfter(failures))).toEqual(TWELVE);
    });

    it('never more than 5s, however many failures', () => {
      expect(MAX_DELAY_MS).toBe(5000);
      [12, 100, 1100, 1e6].forEach((failures) => expect(delayAfter(failures)).toBe(5000));
    });
  });

  it('12 sequential attempts: the 6th onwards wait 1s, 2s, 4s, then 5s', async () => {
    const delays = [];
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      delays.push(await service.beforeAttempt('pilgrim@x.com'));
    }
    expect(delays).toEqual(TWELVE);
    expect(slept).toEqual(TWELVE.filter((ms) => ms > 0));
  });

  it('clear() resets the count: the next attempt waits nothing', async () => {
    await attempts('pilgrim@x.com', 8);
    await service.clear('pilgrim@x.com');
    await expect(service.beforeAttempt('pilgrim@x.com')).resolves.toBe(0);
    await expect(RateLimit.countDocuments({})).resolves.toBe(1);
  });

  it('clear() also removes a count from the window before, across a boundary', async () => {
    await attempts('pilgrim@x.com', 7);
    clock += WINDOW_MS;
    await service.clear('pilgrim@x.com');
    await expect(RateLimit.countDocuments({})).resolves.toBe(0);
  });

  it('clear() leaves other addresses alone', async () => {
    await attempts('pilgrim@x.com', 7);
    await attempts('other@x.com', 7);
    await service.clear('pilgrim@x.com');
    await expect(service.beforeAttempt('other@x.com')).resolves.toBe(4000);
  });

  it('a new 15-minute window starts from zero', async () => {
    await attempts('pilgrim@x.com', 9);
    clock += WINDOW_MS;
    await expect(service.beforeAttempt('pilgrim@x.com')).resolves.toBe(0);
  });

  it('counts the address case-insensitively and trimmed', async () => {
    await attempts('pilgrim@x.com', 5);
    await expect(service.beforeAttempt('  PILGRIM@X.com ')).resolves.toBe(1000);
  });

  it('identical counts and delays for an address with an account and one without', async () => {
    await User.create({ email: 'registered@x.com', passwordHash: 'h' });
    const run = async (email) => {
      const delays = [];
      for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        delays.push(await service.beforeAttempt(email));
      }
      return delays;
    };
    expect(await run('registered@x.com')).toEqual(await run('unknown@x.com'));
    const docs = await RateLimit.find({}).lean();
    expect(docs.map((d) => d.count)).toEqual([12, 12]);
  });

  it('parallel attempts are all counted, with no duplicate-key failure', async () => {
    const delays = await Promise.all(
      Array.from({ length: 12 }, () => service.beforeAttempt('pilgrim@x.com'))
    );
    expect([...delays].sort((a, b) => a - b)).toEqual(TWELVE);
    const docs = await RateLimit.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].count).toBe(12);
  });

  it('the key holds a sha256 of the address and the window, never the address', async () => {
    await service.beforeAttempt('pilgrim@x.com');
    const [doc] = await RateLimit.find({}).lean();
    expect(doc.key).toMatch(/^login-fail:[0-9a-f]{64}:\d+$/);
    expect(doc.key).not.toContain('pilgrim');
    expect(doc.key).not.toContain('@');
    expect(doc.key.endsWith(`:${BUCKET}`)).toBe(true);
  });

  it('purgeAt is the end of the window plus one more window', async () => {
    await service.beforeAttempt('pilgrim@x.com');
    const [doc] = await RateLimit.find({}).lean();
    expect(doc.purgeAt.getTime()).toBe((BUCKET + 2) * WINDOW_MS);
  });

  it('warns once, without the address, when the delay starts', async () => {
    const warn = jest.spyOn(logger, 'warn');
    await attempts('pilgrim@x.com', 12);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ kind: 'login-throttle', failures: 5 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('pilgrim');
  });

  it('retries once after a duplicate-key race', async () => {
    const original = RateLimit.findOneAndUpdate.bind(RateLimit);
    jest
      .spyOn(RateLimit, 'findOneAndUpdate')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      })
      .mockImplementation((...args) => original(...args));

    await expect(service.beforeAttempt('pilgrim@x.com')).resolves.toBe(0);
    expect(RateLimit.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('any other database error propagates, and nothing sleeps', async () => {
    jest.spyOn(RateLimit, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    await expect(service.beforeAttempt('pilgrim@x.com')).rejects.toThrow('connection reset');
    expect(slept).toEqual([]);
  });

  it('the default sleep really waits', async () => {
    const real = createLoginThrottleService({ now: () => new Date(clock) });
    await attempts('pilgrim@x.com', 5);
    const startedAt = Date.now();
    await expect(real.beforeAttempt('pilgrim@x.com')).resolves.toBe(1000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(990);
  });
});
