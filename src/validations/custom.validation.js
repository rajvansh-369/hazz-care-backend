'use strict';

const mongoose = require('mongoose');

/** Joi custom rule: value must be a 24 character MongoDB ObjectId. */
const objectId = (value, helpers) => {
  if (
    !mongoose.Types.ObjectId.isValid(value) ||
    String(new mongoose.Types.ObjectId(value)) !== value
  ) {
    return helpers.message('{{#label}} must be a valid id');
  }
  return value;
};

/** Joi custom rule: strong password policy, mirrored in the User model. */
const password = (value, helpers) => {
  if (value.length < 8) {
    return helpers.message('{{#label}} must be at least 8 characters');
  }
  if (!/[a-z]/.test(value)) {
    return helpers.message('{{#label}} must contain a lowercase letter');
  }
  if (!/[A-Z]/.test(value)) {
    return helpers.message('{{#label}} must contain an uppercase letter');
  }
  if (!/\d/.test(value)) {
    return helpers.message('{{#label}} must contain a number');
  }
  if (!/[^A-Za-z\d]/.test(value)) {
    return helpers.message('{{#label}} must contain a special character');
  }
  return value;
};

module.exports = { objectId, password };
