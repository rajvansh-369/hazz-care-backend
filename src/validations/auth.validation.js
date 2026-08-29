'use strict';

const Joi = require('joi');
const { password } = require('./custom.validation');

// ============================================================================
// COMMON VALIDATORS
// ============================================================================

const email = Joi.string().trim().lowercase().email().max(254);

const phone = Joi.string()
  .pattern(/^\+\d{1,3}\d{4,14}$/)
  .messages({ 'string.pattern.base': 'Phone must be in E.164 format (e.g., +966501234567)' });

const locale = Joi.string()
  .valid('en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr');

// ============================================================================
// EMAIL/PASSWORD AUTH (Keep existing flow)
// ============================================================================

const register = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(2).max(80).required(),
    email: email.required(),
    password: Joi.string().max(128).custom(password).required(),
  }),
};

const login = {
  body: Joi.object().keys({
    email: email.required(),
    password: Joi.string().max(128).required(),
  }),
};

const refreshTokens = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required(),
  }),
};

const logout = refreshTokens;

const forgotPassword = {
  body: Joi.object().keys({
    email: email.required(),
  }),
};

const resetPassword = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    password: Joi.string().max(128).custom(password).required(),
  }),
};

const verifyEmail = {
  body: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    currentPassword: Joi.string().max(128).required(),
    newPassword: Joi.string().max(128).custom(password).required(),
  }),
};

// ============================================================================
// OTP AUTH (Phone-first, per CLAUDE.md §4)
// ============================================================================

const requestOtp = {
  body: Joi.object().keys({
    phone: phone.required(),
    locale: locale.required(),
  }),
};

const verifyOtp = {
  body: Joi.object().keys({
    challengeId: Joi.string().uuid().required(),
    code: Joi.string().length(6).pattern(/^\d+$/).required().messages({
      'string.pattern.base': 'Code must be 6 digits',
    }),
  }),
};

const refresh = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required(),
  }),
};

const registerDevice = {
  body: Joi.object().keys({
    pushToken: Joi.string().max(512).required(),
    platform: Joi.string().valid('ios', 'android', 'web').required(),
    appVersion: Joi.string().max(20).required(),
    locale: locale.required(),
  }),
};

module.exports = {
  // Email/password
  register,
  login,
  refreshTokens,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  // OTP
  requestOtp,
  verifyOtp,
  refresh,
  registerDevice,
};
