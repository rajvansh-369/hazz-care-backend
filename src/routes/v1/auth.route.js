'use strict';

const express = require('express');
const { authController } = require('../../controllers');
const requireAuth = require('../../middlewares/auth.middleware');
const errorCodes = require('../../utils/errorCodes');
const { sendJson } = require('../../utils/respond');

const router = express.Router();

// The nine-endpoint contract: BACKEND_SPEC.md §3. Rules that live here:
// - requireAuth is attached to GET /me ONLY, never with router.use() (CLAUDE.md A3).
// - No generic Joi validate middleware: each handler maps bad input to the
//   contract's specific codes (password_too_short, email_invalid, ...).
// - No rate limiter on /login or /register, ever. Others are added per route.
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-otp', authController.verifyOtp);
router.post('/reset-password', authController.resetPassword);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

// Catch-all: no path under the auth router may ever 404. The client shows any 404
// as "We could not find an account for that email address" (BACKEND_SPEC.md §3.2).
router.use((req, res) => sendJson(res, 503, { code: errorCodes.unavailable }));

module.exports = router;
