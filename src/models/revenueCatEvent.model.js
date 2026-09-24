'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

/**
 * Every RevenueCat webhook delivery, stored before any processing (CLAUDE.md A5).
 *
 * `_id` is RevenueCat's `event.id`: the primary key IS the idempotency guarantee, so a
 * retried delivery is an E11000 the service drops.
 *
 * `rawBody` is the request body exactly as received (the bytes the HMAC signature
 * covers), kept for re-verification and replay. Anonymous-id events are stored like
 * any other; `aliases` is what reconciles them to an account later.
 */
const revenueCatEventSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
    },
    type: {
      type: String,
      required: true,
    },
    appUserId: {
      type: String,
      required: true,
      index: true,
    },
    aliases: {
      type: [String],
      default: [],
      index: true,
    },
    environment: {
      type: String,
    },
    entitlementIds: {
      type: [String],
      default: [],
    },
    rawBody: {
      type: String,
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    processingError: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

revenueCatEventSchema.plugin(toJSON);

const RevenueCatEvent = mongoose.model('RevenueCatEvent', revenueCatEventSchema);

module.exports = RevenueCatEvent;
