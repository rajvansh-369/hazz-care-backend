'use strict';

const express = require('express');
const { authController } = require('../../controllers');
const { authValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const bearerAuth = require('../../middlewares/bearerAuth.middleware');

const router = express.Router();

// Layer A endpoints only
router.post('/register', validate(authValidation.register), authController.register);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/refresh', validate(authValidation.refreshTokens), authController.refreshTokens);
router.post('/logout', authController.logout);
router.post('/forgot-password', validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/verify-otp', authController.verifyOtp);
router.post('/reset-password', validate(authValidation.resetPassword), authController.resetPassword);
router.get('/me', bearerAuth, authController.me);

module.exports = router;
