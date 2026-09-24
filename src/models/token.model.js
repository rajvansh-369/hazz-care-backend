'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const REVOKED_REASONS = ['LOGOUT', 'ROTATED', 'PASSWORD_RESET', 'ADMIN'];

/**
 * Refresh and reset tokens. Only the hash is stored; the raw token never touches the
 * database (CLAUDE.md A8, C3).
 *
 * Refresh rotation (CLAUDE.md A10 rule l): the old token records `replacedBy` and
 * `rotatedAt`, and stays usable for REFRESH_ROTATION_GRACE_SECONDS measured from
 * `rotatedAt`. `familyId` links every token descended from one sign-in.
 *
 * Reset tokens are single use: `consumedAt` is set atomically when one is spent.
 */
const tokenSchema = new mongoose.Schema(
  {
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      private: true,
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['refresh', 'resetPassword'],
      required: true,
    },
    familyId: {
      type: String,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    // Garbage-collection time only. The service sets it to expiresAt + 7 days (refresh)
    // or expiresAt + 24 hours (reset). Expiry is always checked in code against expiresAt.
    purgeAt: {
      type: Date,
      required: true,
    },
    rotatedAt: {
      type: Date,
      default: null,
    },
    replacedBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Token',
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      enum: [...REVOKED_REASONS, null],
      default: null,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// TTL on purgeAt, never on expiresAt (CLAUDE.md A8 point 4, A11). TTL deletion is lazy
// (roughly once a minute): it is garbage collection, not the expiry mechanism.
tokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

tokenSchema.plugin(toJSON);

const Token = mongoose.model('Token', tokenSchema);

module.exports = Token;
module.exports.REVOKED_REASONS = REVOKED_REASONS;
