'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const entitlementSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    productId: {
      type: String,
      required: true,
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
