'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

/**
 * Server-side record of the lifetime pass, for support ("did this person pay") and so
 * a refund has somewhere to land. It gates nothing: the client decides access from its
 * own database (CLAUDE.md A5).
 *
 * `entitlementId` comes from config HAJJCARE_ENTITLEMENT_ID, never from product_id
 * (BACKEND_SPEC.md §6b rule 3).
 *
 * NO expiry field of any kind: the pass is lifetime (BACKEND_SPEC.md §6b rule 5).
 */
const entitlementSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    entitlementId: {
      type: String,
      required: true,
    },
    store: {
      type: String,
    },
    transactionId: {
      type: String,
    },
    grantedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

entitlementSchema.plugin(toJSON);

const Entitlement = mongoose.model('Entitlement', entitlementSchema);

module.exports = Entitlement;
