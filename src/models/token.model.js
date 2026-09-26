'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

// SUPERSEDED: another token in the family was used, so this one can no longer refresh
// (CLAUDE.md A10 rule l). Rotation itself revokes nothing.
const REVOKED_REASONS = ['LOGOUT', 'SUPERSEDED', 'PASSWORD_RESET', 'ADMIN'];

/**
 * Refresh and reset tokens. Only the hash is stored; the raw token never touches the
 * database (CLAUDE.md A8, C3).
 *
 * Refresh tokens from one sign-in form a tree (the family, `familyId`): each token
 * records the `parent` it was minted from. `rotatedAt` is the first time a token was
 * used; it stays usable, minting siblings for its child, until one of its children is
 * used (CLAUDE.md A10 rule l). `childCount` counts every child it minted.
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
    // The token this one was minted from; null for the token a sign-in issues.
    parent: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Token',
      default: null,
      index: true,
    },
    rotatedAt: {
      type: Date,
      default: null,
    },
    childCount: {
      type: Number,
      default: 0,
      min: 0,
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
