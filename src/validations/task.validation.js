'use strict';

const Joi = require('joi');
const { objectId } = require('./custom.validation');
const { TASK_STATUSES, TASK_PRIORITIES } = require('../config/constants');

const taskBody = {
  title: Joi.string().trim().min(3).max(120),
  description: Joi.string().trim().allow('').max(2000),
  status: Joi.string().valid(...TASK_STATUSES),
  priority: Joi.string().valid(...TASK_PRIORITIES),
  dueDate: Joi.date().iso().allow(null),
  tags: Joi.array().items(Joi.string().trim().min(1).max(24)).max(10),
};

const createTask = {
  body: Joi.object().keys({
    ...taskBody,
    title: taskBody.title.required(),
  }),
};

const getTasks = {
  query: Joi.object().keys({
    title: Joi.string().trim().max(120),
    status: Joi.string().valid(...TASK_STATUSES),
    priority: Joi.string().valid(...TASK_PRIORITIES),
    sortBy: Joi.string().max(60),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const getTask = {
  params: Joi.object().keys({
    taskId: Joi.string().custom(objectId).required(),
  }),
};

const updateTask = {
  params: Joi.object().keys({
    taskId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys(taskBody).min(1),
};

const deleteTask = getTask;

module.exports = { createTask, getTasks, getTask, updateTask, deleteTask };
