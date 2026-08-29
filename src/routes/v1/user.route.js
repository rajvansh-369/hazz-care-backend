'use strict';

const express = require('express');
const { userController } = require('../../controllers');
const { userValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');

const router = express.Router();

// Self-service profile routes
// Declared before `/:userId` so `/me` is never interpreted as an id
router
  .route('/me')
  .get(auth(), validate(userValidation.getMe), userController.getMe)
  .patch(auth(), validate(userValidation.updateMe), userController.updateMe);

// User list & create (admin only)
router
  .route('/')
  .get(auth(), validate(userValidation.getUsers), userController.getUsers);

// User CRUD by ID (admin)
router
  .route('/:userId')
  .get(auth(), validate(userValidation.getUser), userController.getUser)
  .patch(auth(), validate(userValidation.updateUser), userController.updateUser)
  .delete(auth(), validate(userValidation.deleteUser), userController.deleteUser);

module.exports = router;
