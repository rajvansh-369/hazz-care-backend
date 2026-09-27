'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');
const { RateLimit } = require('../models');

const WINDOW_MS = 15 * 60 * 1000;
const FREE_FAILURES = 5;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;
const DUPLICATE_KEY = 11000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * The wait for one sign-in attempt, given how many attempts on its address came
 * before it in this window without a success: nothing for the first five, then 1s, 2s,
 * 4s, and 5s from then on. Never more than MAX_DELAY_MS, so the answer stays well
 * inside the client's 15-second receive timeout.
 *
 * @param {number} failures
 * @returns {number} milliseconds
 */
const delayAfter = (failures) =>
  failures < FREE_FAILURES
    ? 0
    : Math.min(FIRST_DELAY_MS * 2 ** (failures - FREE_FAILURES), MAX_DELAY_MS);

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Progressive delay on POST /auth/login (CLAUDE.md A7, decided 2026-09-27). It only
 * slows the answer down: the status and body are exactly what they would have been,
 * 401 invalid_credentials or 200, and never 429 (BACKEND_SPEC.md §3.4).
 *
 * Counters live in RateLimit, keyed "login-fail:<sha256(email)>:<15-minute bucket>",
 * like the OTP send limit: fixed windows, so a run of failures that straddles a window
 * boundary starts again from zero. The key holds a hash of the address, never the
 * address.
 *
 * Every attempt is counted BEFORE the user lookup and argon2, as if it will fail, and a
 * success clears the count. So parallel attempts are all counted, a waiting request
 * holds no argon2 thread, and an address with no account is counted exactly like one
 * with an account (no enumeration).
 *
 * This bounds how long one attempt takes, not how many run at once: attempts sent in
 * parallel each wait their own delay side by side.
 *
 * @param {{ now?: () => Date, sleep?: (ms: number) => Promise<void> }} [deps]
 */
const createLoginThrottleService = ({ now = () => new Date(), sleep = defaultSleep } = {}) => {
  const keyFor = (email, bucket) =>
    `login-fail:${sha256(String(email).trim().toLowerCase())}:${bucket}`;

  const currentBucket = () => Math.floor(now().getTime() / WINDOW_MS);

  const increment = (key, purgeAt) =>
    RateLimit.findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { purgeAt } },
      { upsert: true, new: true }
    );

  /**
   * Counts this attempt, then waits the delay earned by the failures before it.
   * Call before looking the user up and before argon2.
   *
   * @param {string} email
   * @returns {Promise<number>} the delay waited, in milliseconds
   */
  const beforeAttempt = async (email) => {
    const bucket = currentBucket();
    const key = keyFor(email, bucket);
    const purgeAt = new Date((bucket + 2) * WINDOW_MS);

    let doc;
    try {
      doc = await increment(key, purgeAt);
    } catch (error) {
      // Two first attempts in the same window can both try to insert; the loser
      // retries once and then finds the document.
      if (!error || error.code !== DUPLICATE_KEY) {
        throw error;
      }
      doc = await increment(key, purgeAt);
    }

    const failures = doc.count - 1;
    if (failures === FREE_FAILURES) {
      // Once per address per window, and without the address.
      logger.warn('Sign-in failures for one address reached the delay threshold', {
        kind: 'login-throttle',
        failures,
      });
    }
    const delayMs = delayAfter(failures);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    return delayMs;
  };

  /**
   * A successful sign-in forgets the failures counted for its address. The previous
   * window is cleared too, in case the attempt was counted just before a boundary.
   *
   * @param {string} email
   */
  const clear = async (email) => {
    const bucket = currentBucket();
    await RateLimit.deleteMany({
      key: { $in: [keyFor(email, bucket), keyFor(email, bucket - 1)] },
    });
  };

  return { beforeAttempt, clear, keyFor };
};

module.exports = {
  ...createLoginThrottleService(),
  createLoginThrottleService,
  delayAfter,
  WINDOW_MS,
  FREE_FAILURES,
  MAX_DELAY_MS,
};
