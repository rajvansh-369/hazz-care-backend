'use strict';

const setupTestDB = require('../utils/setupTestDB');
const config = require('../../src/config/config');
const { RateLimit, User } = require('../../src/models');
const { createSendLimitService } = require('../../src/services/sendLimit.service');

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-24T12:10:00.000Z').getTime();

describe('sendLimit.service', () => {
  setupTestDB();

  let clock;
  let service;

  const consumeTimes = async (email, times) => {
    const results = [];
    for (let i = 0; i < times; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push((await service.consume(email)).allowed);
    }
    return results;
  };

  beforeAll(async () => {
    await RateLimit.createCollection();
    await RateLimit.init();
  });

  beforeEach(() => {
    clock = T0;
    service = createSendLimitService({ now: () => new Date(clock) });
  });

  it('allows OTP_MAX_SENDS_PER_HOUR (5) sends in one hour and refuses the 6th', async () => {
    expect(config.otp.maxSendsPerHour).toBe(5);
    await expect(consumeTimes('pilgrim@x.com', 6)).resolves.toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('a new hour bucket resets it', async () => {
    await consumeTimes('pilgrim@x.com', 6);
    clock += HOUR;
    await expect(service.consume('pilgrim@x.com')).resolves.toEqual({ allowed: true });
  });

  it('counts the address case-insensitively and trimmed', async () => {
    await consumeTimes('pilgrim@x.com', 5);
    await expect(service.consume('  PILGRIM@X.com ')).resolves.toEqual({ allowed: false });
  });

  it('different addresses have separate budgets', async () => {
    await consumeTimes('pilgrim@x.com', 6);
    await expect(service.consume('other@x.com')).resolves.toEqual({ allowed: true });
  });

  it('identical results for an address with an account and one without', async () => {
    await User.create({ email: 'registered@x.com', passwordHash: 'h' });
    const registered = await consumeTimes('registered@x.com', 7);
    const unknown = await consumeTimes('unknown@x.com', 7);
    expect(registered).toEqual(unknown);

    const docs = await RateLimit.find({}).lean();
    expect(docs.map((d) => d.count).sort()).toEqual([7, 7]);
  });

  it('the key holds a sha256 of the address, never the address', async () => {
    await service.consume('pilgrim@x.com');
    const [doc] = await RateLimit.find({}).lean();
    expect(doc.key).toMatch(/^otp-send:[0-9a-f]{64}:\d+$/);
    expect(doc.key).not.toContain('pilgrim');
    expect(doc.key).not.toContain('@');
    expect(doc.key.endsWith(`:${Math.floor(T0 / HOUR)}`)).toBe(true);
  });

  it('purgeAt is the end of the bucket plus one hour', async () => {
    await service.consume('pilgrim@x.com');
    const [doc] = await RateLimit.find({}).lean();
    const bucketEnd = (Math.floor(T0 / HOUR) + 1) * HOUR;
    expect(doc.purgeAt.getTime()).toBe(bucketEnd + HOUR);
  });

  it('parallel first sends for one address all count, with no duplicate-key failure', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.consume('pilgrim@x.com'))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const docs = await RateLimit.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].count).toBe(8);
  });

  it('retries once after a duplicate-key race', async () => {
    const original = RateLimit.findOneAndUpdate.bind(RateLimit);
    jest
      .spyOn(RateLimit, 'findOneAndUpdate')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      })
      .mockImplementation((...args) => original(...args));

    await expect(service.consume('pilgrim@x.com')).resolves.toEqual({ allowed: true });
    expect(RateLimit.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('any other database error propagates', async () => {
    jest.spyOn(RateLimit, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    await expect(service.consume('pilgrim@x.com')).rejects.toThrow('connection reset');
  });
});
