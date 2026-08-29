'use strict';

const { Task } = require('../models');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const canManageAnyTask = (user) =>
  Array.isArray(user.rights) && user.rights.includes('tasks:manage-any');

/**
 * @param {object} taskBody
 * @param {{id: string, role: string, rights: string[]}} principal Authenticated principal.
 * @returns {Promise<Task>}
 */
const createTask = async (taskBody, user) => Task.create({ ...taskBody, owner: user.id });

/**
 * Non-admins are always scoped to their own tasks, whatever filter they send.
 *
 * @param {object} filter
 * @param {object} options
 * @param {object} user
 * @returns {Promise<object>}
 */
const queryTasks = async (filter, options, user) => {
  const scopedFilter = { ...filter };
  if (!canManageAnyTask(user)) {
    scopedFilter.owner = user.id;
  }
  if (scopedFilter.title) {
    // Anchored, escaped prefix search keeps the query index friendly and safe.
    const escaped = String(scopedFilter.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scopedFilter.title = { $regex: `^${escaped}`, $options: 'i' };
  }
  return Task.paginate(scopedFilter, options);
};

/**
 * @param {string} taskId
 * @param {object} user
 * @returns {Promise<Task>}
 */
const getTaskById = async (taskId, user) => {
  const task = await Task.findById(taskId);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (!canManageAnyTask(user) && String(task.owner) !== String(user.id)) {
    // 404 rather than 403: never confirm the existence of another user's record.
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  return task;
};

/**
 * @param {string} taskId
 * @param {object} updateBody
 * @param {object} user
 * @returns {Promise<Task>}
 */
const updateTaskById = async (taskId, updateBody, user) => {
  const task = await getTaskById(taskId, user);
  Object.assign(task, updateBody);
  await task.save();
  return task;
};

/**
 * @param {string} taskId
 * @param {object} user
 * @returns {Promise<Task>}
 */
const deleteTaskById = async (taskId, user) => {
  const task = await getTaskById(taskId, user);
  await task.deleteOne();
  return task;
};

/**
 * @param {object} user
 * @returns {Promise<{total: number, todo: number, in_progress: number, done: number}>}
 */
const getTaskStats = async (user) => {
  const baseFilter = canManageAnyTask(user) ? {} : { owner: user.id };
  const [total, todo, inProgress, done] = await Promise.all([
    Task.countDocuments(baseFilter),
    Task.countDocuments({ ...baseFilter, status: 'todo' }),
    Task.countDocuments({ ...baseFilter, status: 'in_progress' }),
    Task.countDocuments({ ...baseFilter, status: 'done' }),
  ]);
  return { total, todo, in_progress: inProgress, done };
};

module.exports = {
  createTask,
  queryTasks,
  getTaskById,
  updateTaskById,
  deleteTaskById,
  getTaskStats,
};
