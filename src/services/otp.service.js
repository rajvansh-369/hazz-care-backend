'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config/config');
const { PasswordResetOtp } = require('../models');

const HOUR_MS = 60 * 60 * 1000;
const PURGE_AFTER_MS = 24 * HOUR_MS;

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
  const codeSpace = 10 ** config.otp.length;
  const generateCode = () => String(crypto.randomInt(0, codeSpace)).padStart(config.otp.length, '0');

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
   * Why the attempt charge in verify() matched nothing, decided from a fresh read in
   * the spec's order. A code that is no longer the active one — spent by a concurrent
   * verify, voided by a resend, or purged — is 'invalid', exactly as if no code had
   * been found.
   *
   * @returns {Promise<'locked'|'expired'|'invalid'>}
   */
  const refusalFor = async (id, at) => {
    const current = await PasswordResetOtp.findById(id);
    if (!current || current.consumedAt || current.supersededAt) {
      return 'invalid';
    }
    if (current.attempts >= maxAttempts) {
      return 'locked';
    }
    if (current.expiresAt.getTime() <= at.getTime()) {
      return 'expired';
    }
    // Unreachable: every field in the charge filter only ever moves one way.
    return 'invalid';
  };

  /**
   * Checks, in this order (BACKEND_SPEC.md §3.7):
   *   a) locked   — attempts >= max, BEFORE the code, so the right code still waits;
   *   b) expired  — no attempt charged: never punish a pilgrim for a clock;
   *   c) invalid  — wrong code;
   *   d) ok       — right code, consumed atomically (single use).
   * No active code for the address, known or not, is simply 'invalid'.
   *
   * Every guess is charged BEFORE the code is compared, by one atomic update whose
   * filter carries all the preconditions, so at most maxAttempts guesses are ever
   * compared per code however many arrive in parallel. Reading `attempts` first and
   * charging after the compare let a burst of parallel requests all read a count
   * below the limit, and the right code among them got through. The right code is
   * charged too, which no client can see: it is consumed straight after.
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

    const at = now();
    const charged = await PasswordResetOtp.findOneAndUpdate(
      {
        _id: doc._id,
        consumedAt: null,
        supersededAt: null,
        attempts: { $lt: maxAttempts },
        // An expired code is never charged: never punish a pilgrim for a clock.
        expiresAt: { $gt: at },
      },
      { $inc: { attempts: 1 } }
    );
    if (!charged) {
      return { error: await refusalFor(doc._id, at) };
    }

    const candidate = hashCode(String(doc.user), typeof code === 'string' ? code : '');
    if (typeof code !== 'string' || !hashesMatch(doc.codeHash, candidate)) {
      return { error: 'invalid' };
    }

    const consumed = await PasswordResetOtp.findOneAndUpdate(
      { _id: doc._id, consumedAt: null, supersededAt: null },
      { $set: { consumedAt: at } }
    );
    if (!consumed) {
      // A concurrent verify spent this code first, or a resend voided it.
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
