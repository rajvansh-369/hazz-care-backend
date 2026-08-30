'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const emergencyContactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Contact name is required'],
      trim: true,
      maxlength: [80, 'Name must be at most 80 characters'],
    },
    relationship: {
      type: String,
      enum: {
        values: ['spouse', 'child', 'parent', 'sibling', 'friend', 'other'],
        message: 'Relationship must be one of: spouse, child, parent, sibling, friend, other',
      },
      required: [true, 'Relationship is required'],
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
      maxlength: [20, 'Phone must be at most 20 characters'],
    },
    whatsappNumber: {
      type: String,
      trim: true,
      maxlength: [20, 'WhatsApp number must be at most 20 characters'],
      default: null,
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    notifyOrder: {
      type: Number,
      min: [1, 'Notify order must be at least 1'],
      max: [5, 'Notify order must be at most 5'],
      default: 1,
    },
    locale: {
      type: String,
      enum: {
        values: ['en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr'],
        message: 'Locale must be one of: en, ar, ur, id, fr, bn, tr',
      },
      default: 'en',
    },
  },
  {
    timestamps: true,
    versionKey: '__v',
  }
);

emergencyContactSchema.plugin(toJSON);

// Ensure max 5 emergency contacts per user
emergencyContactSchema.index({ userId: 1, createdAt: -1 });

const EmergencyContact = mongoose.model('EmergencyContact', emergencyContactSchema);

module.exports = EmergencyContact;
