'use strict';

const mongoose = require('mongoose');

/**
 * Fixed-window counters, one document per key per window, keyed like
 * "otp-send:<sha256(email)>:<hour-bucket>". The service increments with an upsert and
 * sets purgeAt past the end of the window; the TTL index cleans up behind it.
 */
const rateLimitSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  count: {
    type: Number,
    default: 0,
  },
  purgeAt: {
    type: Date,
    required: true,
  },
});

rateLimitSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const RateLimit = mongoose.model('RateLimit', rateLimitSchema);

module.exports = RateLimit;
