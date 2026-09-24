'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const { RateLimit } = require('../models');

const HOUR_MS = 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Per-address limit on reset-code emails: OTP_MAX_SENDS_PER_HOUR in fixed hourly
 * windows (CLAUDE.md A7).
 *
 * It runs identically whether or not an account exists for the address — otherwise
 * the limiter itself would reveal which addresses are registered (§3.6, §6). The key
 * holds a sha256 of the address, never the address.
 *
 * There is deliberately no 60-second resend cooldown here: the device already refuses
 * early resends, and a server cooldown would show "Too many tries" to a pilgrim who
 * went back and re-entered their address.
 *
 * @param {{ now?: () => Date }} [deps]
 */
const createSendLimitService = ({ now = () => new Date() } = {}) => {
  const keyFor = (email, bucket) =>
    `otp-send:${sha256(String(email).trim().toLowerCase())}:${bucket}`;

  const increment = (key, purgeAt) =>
    RateLimit.findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { purgeAt } },
      { upsert: true, new: true }
    );

  /**
   * @param {string} email
   * @returns {Promise<{ allowed: boolean }>}
   */
  const consume = async (email) => {
    const bucket = Math.floor(now().getTime() / HOUR_MS);
    const key = keyFor(email, bucket);
    const purgeAt = new Date((bucket + 1) * HOUR_MS + HOUR_MS);

    let doc;
    try {
      doc = await increment(key, purgeAt);
    } catch (error) {
      // Two first-sends in the same window can both try to insert; the loser retries
      // once and then finds the document.
      if (!error || error.code !== DUPLICATE_KEY) {
        throw error;
      }
      doc = await increment(key, purgeAt);
    }
    return { allowed: doc.count <= config.otp.maxSendsPerHour };
  };

  return { consume, keyFor };
};

module.exports = {
  ...createSendLimitService(),
  createSendLimitService,
};
