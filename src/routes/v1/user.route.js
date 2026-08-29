'use strict';

const express = require('express');
const { userController } = require('../../controllers');
const { userValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');

const router = express.Router();

// Self-service profile routes. Declared before `/:userId` so `me` is never
// interpreted as an id.
router
  .route('/me')
  .get(auth(), userController.getMe)
  .patch(auth(), validate(userValidation.updateMe), userController.updateMe);

router
  .route('/')
  .post(auth('users:write'), validate(userValidation.createUser), userController.createUser)
  .get(auth('users:read'), validate(userValidation.getUsers), userController.getUsers);

router
  .route('/:userId')
  .get(
    auth({ rights: ['users:read'], allowSelf: true }),
    validate(userValidation.getUser),
    userController.getUser
  )
  .patch(auth('users:write'), validate(userValidation.updateUser), userController.updateUser)
  .delete(auth('users:write'), validate(userValidation.deleteUser), userController.deleteUser);

module.exports = router;
