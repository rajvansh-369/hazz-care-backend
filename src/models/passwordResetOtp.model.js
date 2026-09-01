'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const passwordResetOtpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      index: true,
      lowercase: true,
    },
    codeHash: {
      type: String,
      required: true,
      unique: true,
      private: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// TTL index: MongoDB deletes documents when expiresAt passes (expireAfterSeconds: 0 = immediate).
// CRITICAL: TTL deletion is lazy — MongoDB sweeps roughly once per minute. Code MUST check
// expiresAt explicitly in memory; TTL is garbage collection only, not the expiry mechanism.
passwordResetOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

passwordResetOtpSchema.plugin(toJSON);

const PasswordResetOtp = mongoose.model('PasswordResetOtp', passwordResetOtpSchema);

module.exports = PasswordResetOtp;
