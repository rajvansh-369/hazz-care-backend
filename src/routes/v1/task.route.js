'use strict';

const express = require('express');
const { taskController } = require('../../controllers');
const { taskValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');

const router = express.Router();

// Every task route requires an authenticated principal; ownership is enforced
// again in the service layer so a mistake in routing cannot leak data.
router.use(auth('tasks:manage-own'));

router.get('/stats', taskController.getTaskStats);

router
  .route('/')
  .post(validate(taskValidation.createTask), taskController.createTask)
  .get(validate(taskValidation.getTasks), taskController.getTasks);

router
  .route('/:taskId')
  .get(validate(taskValidation.getTask), taskController.getTask)
  .patch(validate(taskValidation.updateTask), taskController.updateTask)
  .delete(validate(taskValidation.deleteTask), taskController.deleteTask);

module.exports = router;
