'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config/config');
const { PasswordResetOtp } = require('../models');

const HOUR_MS = 60 * 60 * 1000;
const PURGE_AFTER_MS = 24 * HOUR_MS;
const CODE_SPACE = 10 ** 6;

const normaliseEmail = (email) => String(email).trim().toLowerCase();

/**
 * HMAC-SHA256 with a server secret, bound to the account. A plain sha256 of a
 * six-digit code is reversed from a database leak by trying all million values
 * (CLAUDE.md A11); the code itself is never stored or logged.
 */
const hashCode = (userId, code) =>
  crypto.createHmac('sha256', config.otp.hmacSecret).update(`${userId}:${code}`).digest('hex');

const hashesMatch = (storedHex, candidateHex) => {
  const stored = Buffer.from(String(storedHex), 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
};

/**
 * Password-reset codes (BACKEND_SPEC.md §3.6, §3.7, §5).
 *
 * `now` is injectable so tests move the clock instead of sleeping.
 *
 * @param {{ now?: () => Date }} [deps]
 */
const createOtpService = ({ now = () => new Date() } = {}) => {
  const ttlMs = config.otp.ttlSeconds * 1000;
  const maxAttempts = config.otp.maxAttempts;

  /** Six ASCII digits, uniformly random, leading zeros kept. */
  const generateCode = () => String(crypto.randomInt(0, CODE_SPACE)).padStart(config.otp.length, '0');

  /**
   * Voids every active code for the address and stores a fresh one at zero attempts,
   * in one transaction. A resend therefore also lifts a lockout: the Resend button
   * exists to rescue a locked-out pilgrim (BACKEND_SPEC.md §5).
   *
   * @param {{ _id: unknown, email: string }} user
   * @returns {Promise<{ code: string }>} the plain code, for the email only
   */
  const issue = async (user) => {
    const email = normaliseEmail(user.email);
    const code = generateCode();
    const codeHash = hashCode(String(user._id), code);

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const at = now();
        const expiresAt = new Date(at.getTime() + ttlMs);
        await PasswordResetOtp.updateMany(
          { email, consumedAt: null, supersededAt: null },
          { $set: { supersededAt: at } },
          { session }
        );
        await PasswordResetOtp.create(
          [
            {
              email,
              user: user._id,
              codeHash,
              attempts: 0,
              expiresAt,
              purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_MS),
            },
          ],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
    return { code };
  };

  /**
   * The unknown-address path of forgot-password: the same shape of work as issue()
   * — a code, an HMAC, a transaction running the same updateMany — against a filter
   * that cannot match anything, and nothing stored. Timing must not reveal whether
   * an account exists (BACKEND_SPEC.md §3.6, §6).
   */
  const simulateIssue = async () => {
    hashCode('0'.repeat(24), generateCode());
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await PasswordResetOtp.updateMany(
          // No stored email is ever empty, so this matches nothing — through the same index.
          { email: '', consumedAt: null, supersededAt: null },
          { $set: { supersededAt: now() } },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
  };

  /**
   * Checks, in this order (BACKEND_SPEC.md §3.7):
   *   a) locked   — attempts >= max, BEFORE the code, so the right code still waits;
   *   b) expired  — no attempt charged: never punish a pilgrim for a clock;
   *   c) invalid  — wrong code, one attempt charged atomically;
   *   d) ok       — right code, consumed atomically (single use).
   * No active code for the address, known or not, is simply 'invalid'.
   *
   * @param {string} email
   * @param {string} code
   * @returns {Promise<{ ok: true, userId: string } | { error: 'locked'|'expired'|'invalid' }>}
   */
  const verify = async (email, code) => {
    if (typeof email !== 'string') {
      return { error: 'invalid' };
    }
    const doc = await PasswordResetOtp.findOne({
      email: normaliseEmail(email),
      consumedAt: null,
      supersededAt: null,
    })
      .sort({ createdAt: -1, _id: -1 });

    if (!doc) {
      return { error: 'invalid' };
    }
    if (doc.attempts >= maxAttempts) {
      return { error: 'locked' };
    }
    const at = now();
    if (doc.expiresAt.getTime() <= at.getTime()) {
      return { error: 'expired' };
    }

    const candidate = hashCode(String(doc.user), typeof code === 'string' ? code : '');
    if (typeof code !== 'string' || !hashesMatch(doc.codeHash, candidate)) {
      const charged = await PasswordResetOtp.findOneAndUpdate(
        { _id: doc._id, attempts: { $lt: maxAttempts } },
        { $inc: { attempts: 1 } }
      );
      // Nothing matched: concurrent guesses already used the last attempt.
      return { error: charged ? 'invalid' : 'locked' };
    }

    const consumed = await PasswordResetOtp.findOneAndUpdate(
      { _id: doc._id, consumedAt: null },
      { $set: { consumedAt: at } }
    );
    if (!consumed) {
      // A concurrent verify spent this code first.
      return { error: 'invalid' };
    }
    return { ok: true, userId: String(doc.user) };
  };

  /**
   * Voids every active code for the account (used by the password reset).
   * @param {string|import('mongoose').Types.ObjectId} userId
   * @param {{ session?: import('mongoose').ClientSession }} [options]
   */
  const supersedeAllForUser = async (userId, { session } = {}) => {
    await PasswordResetOtp.updateMany(
      { user: userId, consumedAt: null, supersededAt: null },
      { $set: { supersededAt: now() } },
      { session }
    );
  };

  return { generateCode, issue, simulateIssue, verify, supersedeAllForUser };
};

module.exports = {
  ...createOtpService(),
  createOtpService,
  hashCode,
};
