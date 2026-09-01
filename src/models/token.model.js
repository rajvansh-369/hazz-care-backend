'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

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
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Token',
      default: null,
    },
  },
  { timestamps: true }
);

// TTL index: MongoDB deletes documents when expiresAt passes (expireAfterSeconds: 0 = immediate).
// CRITICAL: TTL deletion is lazy — MongoDB sweeps roughly once per minute. Code MUST check
// expiresAt explicitly in memory; TTL is garbage collection only, not the expiry mechanism.
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

tokenSchema.plugin(toJSON);

const Token = mongoose.model('Token', tokenSchema);

module.exports = Token;
