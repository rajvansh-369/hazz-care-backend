'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config/config');
const { toJSON } = require('./plugins');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      private: true,
    },
    emailVerified: {
      type: Boolean,
      default: true,
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

userSchema.methods.isPasswordMatch = async function isPasswordMatch(candidatePassword) {
  if (!this.passwordHash) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }
  try {
    this.passwordHash = await bcrypt.hash(this.passwordHash, config.security.bcryptSaltRounds);
    return next();
  } catch (error) {
    return next(error);
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
