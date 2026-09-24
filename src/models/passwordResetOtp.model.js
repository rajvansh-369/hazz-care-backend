'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

/**
 * One document per code sent by POST /auth/forgot-password. Looked up by email, the
 * only thing verify-otp receives; `user` records the account the code was issued for.
 * Codes are only issued for real accounts: the unknown-address path stores nothing.
 *
 * Lockout is "attempts >= OTP_MAX_ATTEMPTS on the active code". There is no lockedUntil:
 * a resend supersedes the old code (`supersededAt`) and starts a fresh one at zero
 * attempts, which is what unlocks a pilgrim (BACKEND_SPEC.md §5).
 */
const passwordResetOtpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
    },
    // HMAC-SHA256 with OTP_HMAC_SECRET. Deliberately NOT unique: there are only 10^6
    // codes, so two pilgrims will eventually be sent the same one (CLAUDE.md A11).
    codeHash: {
      type: String,
      required: true,
      private: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    // Garbage-collection time only. The service sets it to expiresAt + 24 hours, so an
    // expired code survives and verify-otp can answer otp_expired, not invalid_otp.
    purgeAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    supersededAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// "Latest active code for this address."
passwordResetOtpSchema.index({ email: 1, consumedAt: 1, supersededAt: 1, createdAt: -1 });

// TTL on purgeAt, never on expiresAt (CLAUDE.md A8 point 4, A11).
passwordResetOtpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

passwordResetOtpSchema.plugin(toJSON);

const PasswordResetOtp = mongoose.model('PasswordResetOtp', passwordResetOtpSchema);

module.exports = PasswordResetOtp;
