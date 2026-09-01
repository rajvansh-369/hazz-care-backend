'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

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
    raw: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

revenueCatEventSchema.plugin(toJSON);

const RevenueCatEvent = mongoose.model('RevenueCatEvent', revenueCatEventSchema);

module.exports = RevenueCatEvent;
