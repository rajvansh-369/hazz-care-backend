'use strict';

const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');
const { TASK_STATUSES, TASK_PRIORITIES } = require('../config/constants');

/** Sample business resource used to demonstrate owned, paginated CRUD. */
const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [120, 'Title must be at most 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description must be at most 2000 characters'],
      default: '',
    },
    status: {
      type: String,
      enum: { values: TASK_STATUSES, message: 'Status must be one of: {VALUES}' },
      default: 'todo',
    },
    priority: {
      type: String,
      enum: { values: TASK_PRIORITIES, message: 'Priority must be one of: {VALUES}' },
      default: 'medium',
    },
    dueDate: {
      type: Date,
      default: null,
    },
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (tags) => tags.length <= 10,
        message: 'A task can have at most 10 tags',
      },
    },
    completedAt: {
      type: Date,
      default: null,
    },
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

taskSchema.plugin(toJSON);
taskSchema.plugin(paginate);

taskSchema.pre('save', function stampCompletion(next) {
  if (this.isModified('status')) {
    this.completedAt = this.status === 'done' ? new Date() : null;
  }
  next();
});

const Task = mongoose.model('Task', taskSchema);

module.exports = Task;
