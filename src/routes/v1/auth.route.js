'use strict';

const express = require('express');
const { authController } = require('../../controllers');
const { authValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');
const { authLimiter, otpLimiter } = require('../../middlewares/rateLimiter.middleware');

const router = express.Router();

// ============================================================================
// EMAIL/PASSWORD AUTH FLOW (Keep existing endpoints)
// ============================================================================

router.post('/register', authLimiter, validate(authValidation.register), authController.register);
router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.post(
  '/refresh-tokens',
  validate(authValidation.refreshTokens),
  authController.refreshTokens
);
router.post('/logout-all', auth(), authController.logoutAll);
router.post(
  '/forgot-password',
  authLimiter,
  validate(authValidation.forgotPassword),
  authController.forgotPassword
);
router.post(
  '/reset-password',
  authLimiter,
  validate(authValidation.resetPassword),
  authController.resetPassword
);
router.post('/verify-email', validate(authValidation.verifyEmail), authController.verifyEmail);
router.post(
  '/change-password',
  auth(),
  validate(authValidation.changePassword),
  authController.changePassword
);

// ============================================================================
// OTP AUTH FLOW (Phone-first per CLAUDE.md §4)
// ============================================================================

router.post('/otp/request', otpLimiter, validate(authValidation.requestOtp), authController.requestOtp);
router.post('/otp/verify', otpLimiter, validate(authValidation.verifyOtp), authController.verifyOtp);

// ============================================================================
// SHARED ENDPOINTS (Both auth methods)
// ============================================================================

router.post('/refresh', validate(authValidation.refresh), authController.refresh);
router.post('/logout', validate(authValidation.logout), authController.logout);
router.post('/devices', auth(), validate(authValidation.registerDevice), authController.registerDevice);
router.get('/me', auth(), authController.me);

module.exports = router;
