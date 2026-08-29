'use strict';

const { taskService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const pick = require('../utils/pick');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const createTask = catchAsync(async (req, res) => {
  const task = await taskService.createTask(req.body, req.principal);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'Task created',
    data: { task },
  });
});

const getTasks = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'status', 'priority']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await taskService.queryTasks(filter, options, req.principal);
  return ApiResponse.send(res, {
    message: 'Tasks retrieved',
    data: result.results,
    meta: {
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
    },
  });
});

const getTask = catchAsync(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.principal);
  return ApiResponse.send(res, { message: 'Task retrieved', data: { task } });
});

const updateTask = catchAsync(async (req, res) => {
  const task = await taskService.updateTaskById(req.params.taskId, req.body, req.principal);
  return ApiResponse.send(res, { message: 'Task updated', data: { task } });
});

const deleteTask = catchAsync(async (req, res) => {
  await taskService.deleteTaskById(req.params.taskId, req.principal);
  return res.status(httpStatus.NO_CONTENT).send();
});

const getTaskStats = catchAsync(async (req, res) => {
  const stats = await taskService.getTaskStats(req.principal);
  return ApiResponse.send(res, { message: 'Task statistics', data: stats });
});

module.exports = { createTask, getTasks, getTask, updateTask, deleteTask, getTaskStats };
