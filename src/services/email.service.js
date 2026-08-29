'use strict';

const logger = require('../config/logger');
const config = require('../config/config');

/**
 * Delivery adapter placeholder.
 *
 * The boilerplate ships without an SMTP dependency: every call is logged with the
 * payload a provider would need. Swap the body of `send` for nodemailer, SES,
 * Postmark or similar - the call sites and tests do not change.
 *
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{delivered: boolean, provider: string}>}
 */
const send = async ({ to, subject, text }) => {
  logger.info('Outbound email (no provider configured, logged only)', {
    to,
    subject,
    preview: config.isProduction ? '[redacted]' : text,
  });
  return { delivered: false, provider: 'noop' };
};

const sendResetPasswordEmail = async (to, token) =>
  send({
    to,
    subject: 'Reset your password',
    text: `Use this token to choose a new password within ${config.jwt.resetPasswordExpirationMinutes} minutes: ${token}`,
  });

const sendVerificationEmail = async (to, token) =>
  send({
    to,
    subject: 'Verify your email address',
    text: `Use this token to verify your email within ${config.jwt.verifyEmailExpirationMinutes} minutes: ${token}`,
  });

module.exports = { send, sendResetPasswordEmail, sendVerificationEmail };
