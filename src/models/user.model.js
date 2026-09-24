'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The account. `id` (from `_id` via the toJSON plugin) is the primary key of the
 * pilgrim's local database on the device, so it must serialise as the same non-empty
 * string forever (CLAUDE.md A4, A10 rule c).
 *
 * Password hashing lives in services/password.service.js, never in a hook: a pre-save
 * hook double-hashes on updates (CLAUDE.md A11).
 */
const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      trim: true,
      maxlength: [80, 'Full name must be at most 80 characters'],
      default: null,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email must be at most 254 characters'],
      validate: {
        validator: (value) => EMAIL_REGEX.test(value),
        message: 'Email must be a valid email address',
      },
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      private: true,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: '__v',
  }
);

userSchema.plugin(toJSON);

userSchema.statics.isEmailTaken = async function isEmailTaken(email, excludeUserId) {
  const user = await this.findOne({ email: String(email).toLowerCase() }).select('_id');
  if (!user) {
    return false;
  }
  return String(user._id) !== String(excludeUserId || '');
};

const User = mongoose.model('User', userSchema);

module.exports = User;
