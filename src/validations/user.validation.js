'use strict';

const Joi = require('joi');
const { objectId, password } = require('./custom.validation');
const { roles } = require('../config/roles');

const createUser = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(2).max(80).required(),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    password: Joi.string().max(128).custom(password).required(),
    role: Joi.string().valid(...roles),
    isActive: Joi.boolean(),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    name: Joi.string().trim().max(80),
    email: Joi.string().trim().lowercase().max(254),
    role: Joi.string().valid(...roles),
    isActive: Joi.boolean(),
    sortBy: Joi.string().max(60),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
};

const updateUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(2).max(80),
      email: Joi.string().trim().lowercase().email().max(254),
      password: Joi.string().max(128).custom(password),
      role: Joi.string().valid(...roles),
      isActive: Joi.boolean(),
    })
    .min(1),
};

const updateMe = {
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(2).max(80),
      email: Joi.string().trim().lowercase().email().max(254),
    })
    .min(1),
};

const deleteUser = getUser;

module.exports = { createUser, getUsers, getUser, updateUser, updateMe, deleteUser };
