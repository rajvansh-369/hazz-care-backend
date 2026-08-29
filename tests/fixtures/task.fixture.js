'use strict';

const mongoose = require('mongoose');
const { Task } = require('../../src/models');

const taskOne = (owner) => ({
  _id: new mongoose.Types.ObjectId(),
  title: 'Write the integration tests',
  description: 'Cover the whole auth flow',
  status: 'todo',
  priority: 'high',
  tags: ['testing'],
  owner,
});

const taskTwo = (owner) => ({
  _id: new mongoose.Types.ObjectId(),
  title: 'Review the pull request',
  status: 'in_progress',
  priority: 'medium',
  owner,
});

const insertTasks = async (tasks) => Task.create(tasks.map((task) => ({ ...task })));

module.exports = { taskOne, taskTwo, insertTasks };
