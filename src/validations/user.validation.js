'use strict';

const Joi = require('joi');
const { objectId } = require('./custom.validation');

// E.164 format: +[country_code][number]
const phone = Joi.string()
  .pattern(/^\+\d{1,3}\d{4,14}$/)
  .messages({ 'string.pattern.base': 'Phone must be in E.164 format (e.g., +966501234567)' });

const locale = Joi.string().valid('en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr');

const gender = Joi.string().valid('male', 'female', 'other');

const countryCode = Joi.string().length(2).uppercase(); // ISO 3166-1 alpha-2

const getMe = {};

/**
 * Update self-profile: allowed fields only
 * Cannot change phone (unique, auth-scoped)
 */
const updateMe = {
  body: Joi.object()
    .keys({
      firstName: Joi.string().trim().max(80),
      lastName: Joi.string().trim().max(80),
      email: Joi.string().trim().lowercase().email().max(254),
      dob: Joi.date().max('now'),
      gender: gender,
      locale: locale,
      countryCode: countryCode,
    })
    .min(1),
};

/**
 * List users: cursor-based pagination per CLAUDE.md §2
 */
const getUsers = {
  query: Joi.object().keys({
    cursor: Joi.string().max(512), // opaque pagination token
    limit: Joi.number().integer().min(1).max(100).default(50),
  }),
};

/**
 * Get single user by ID
 */
const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().uuid().required(),
  }),
};

/**
 * Update user (admin)
 * Can update most fields except phone (unique key)
 */
const updateUser = {
  params: Joi.object().keys({
    userId: Joi.string().uuid().required(),
  }),
  body: Joi.object()
    .keys({
      firstName: Joi.string().trim().max(80),
      lastName: Joi.string().trim().max(80),
      email: Joi.string().trim().lowercase().email().max(254),
      dob: Joi.date().max('now'),
      gender: gender,
      locale: locale,
      countryCode: countryCode,
      status: Joi.string().valid('active', 'inactive', 'suspended'),
    })
    .min(1),
};

/**
 * Delete user
 */
const deleteUser = {
  params: Joi.object().keys({
    userId: Joi.string().uuid().required(),
  }),
};

module.exports = {
  getMe,
  updateMe,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
};
