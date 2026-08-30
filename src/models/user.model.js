'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config/config');
const { roles } = require('../config/roles');
const { toJSON, paginate } = require('./plugins');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [80, 'Name must be at most 80 characters'],
    },
    firstName: {
      type: String,
      trim: true,
      maxlength: [40, 'First name must be at most 40 characters'],
    },
    lastName: {
      type: String,
      trim: true,
      maxlength: [40, 'Last name must be at most 40 characters'],
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
    phone: {
      type: String,
      trim: true,
      maxlength: [20, 'Phone must be at most 20 characters'],
    },
    dob: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: {
        values: ['male', 'female', 'other'],
        message: 'Gender must be one of: male, female, other',
      },
      default: null,
    },
    countryCode: {
      type: String,
      trim: true,
      maxlength: [2, 'Country code must be at most 2 characters'],
      default: null,
    },
    locale: {
      type: String,
      enum: {
        values: ['en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr'],
        message: 'Locale must be one of: en, ar, ur, id, fr, bn, tr',
      },
      default: 'en',
    },
    bloodType: {
      type: String,
      enum: {
        values: ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
        message: 'Blood type must be valid',
      },
      default: null,
    },
    heightCm: {
      type: Number,
      min: [50, 'Height must be at least 50 cm'],
      max: [250, 'Height must be at most 250 cm'],
      default: null,
    },
    weightKg: {
      type: Number,
      min: [20, 'Weight must be at least 20 kg'],
      max: [300, 'Weight must be at most 300 kg'],
      default: null,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      validate: {
        // Only validated when the raw value is set; hashed values skip this check.
        validator(value) {
          return this.isModified('password') ? PASSWORD_REGEX.test(value) : true;
        },
        message:
          'Password must contain an uppercase letter, a lowercase letter, a number and a special character',
      },
      private: true,
    },
    role: {
      type: String,
      enum: {
        values: roles,
        message: 'Role must be one of: {VALUES}',
      },
      default: 'user',
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    loginAttempts: {
      type: Number,
      default: 0,
      private: true,
    },
    lockUntil: {
      type: Date,
      default: null,
      private: true,
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
userSchema.plugin(paginate);

userSchema.index({ role: 1 });

/**
 * @param {string} email
 * @param {mongoose.ObjectId} [excludeUserId]
 * @returns {Promise<boolean>}
 */
userSchema.statics.isEmailTaken = async function isEmailTaken(email, excludeUserId) {
  const user = await this.findOne({ email: String(email).toLowerCase() }).select('_id');
  if (!user) {
    return false;
  }
  return String(user._id) !== String(excludeUserId || '');
};

/**
 * @param {string} candidatePassword
 * @returns {Promise<boolean>}
 */
userSchema.methods.isPasswordMatch = async function isPasswordMatch(candidatePassword) {
  if (!this.password) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isLocked = function isLocked() {
  return !!(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

/** Brute force protection: lock the account after N consecutive failures. */
userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const update = { $inc: { loginAttempts: 1 } };
  const attempts = (this.loginAttempts || 0) + 1;
  if (attempts >= config.security.loginMaxAttempts) {
    update.$set = {
      lockUntil: new Date(Date.now() + config.security.loginLockMinutes * 60 * 1000),
    };
  }
  await this.constructor.updateOne({ _id: this._id }, update);
};

userSchema.methods.registerSuccessfulLogin = async function registerSuccessfulLogin() {
  await this.constructor.updateOne(
    { _id: this._id },
    { $set: { loginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } }
  );
};

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }
  try {
    this.password = await bcrypt.hash(this.password, config.security.bcryptSaltRounds);
    return next();
  } catch (error) {
    return next(error);
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
