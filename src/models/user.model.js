'use strict';

const mongoose = require('mongoose');
const { toJSON } = require('./plugins');

// The client's own pattern (BACKEND_SPEC.md §3.3). The server must not be stricter:
// an address the app accepts must never fail here as a ValidationError (a 503).
// eslint-disable-next-line security/detect-unsafe-regex -- the repeated group starts with a literal "." its body cannot contain, so it cannot backtrack
const EMAIL_REGEX = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

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
    // No maxlength on fullName or email: a length rule the client does not have would
    // surface as an opaque 503 instead of an inline error (BACKEND_SPEC.md §3.3).
    fullName: {
      type: String,
      trim: true,
      default: null,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (value) => EMAIL_REGEX.test(value),
        message: 'Email must be a valid email address',
      },
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      private: true,
      // Never loaded unless a query asks for it with .select('+passwordHash').
      select: false,
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
