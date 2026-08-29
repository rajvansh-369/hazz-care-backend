'use strict';

const Joi = require('joi');
const { password } = require('./custom.validation');

const email = Joi.string().trim().lowercase().email().max(254);

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

module.exports = {
  register,
  login,
  logout,
  refreshTokens,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
};
