'use strict';

const mongoose = require('mongoose');

/**
 * RevenueCat App User ID (including "$RCAnonymousID:...") to our account. `user` stays
 * null until an event links the alias to a known account; stored events carrying the
 * alias are reconciled then (BACKEND_SPEC.md §6b rule 2).
 */
const aliasLinkSchema = new mongoose.Schema(
  {
    alias: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

const AliasLink = mongoose.model('AliasLink', aliasLinkSchema);

module.exports = AliasLink;
