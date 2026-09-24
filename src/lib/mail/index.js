'use strict';

const path = require('path');
const config = require('../../config/config');
const { createDevProvider } = require('./devProvider');
const { createSmtpProvider } = require('./smtpProvider');

/**
 * Every provider has one interface: send({ to, subject, text, html, code }) → Promise.
 *
 * Chosen from EMAIL_PROVIDER. config.js already refuses anything but smtp in
 * production; the dev provider asserts it again itself.
 */
const createProvider = (emailConfig = config.email) => {
  if (emailConfig.provider === 'smtp') {
    return createSmtpProvider({ url: emailConfig.smtpUrl, from: emailConfig.from });
  }
  return createDevProvider({
    dir: path.resolve(__dirname, '../../..', emailConfig.devDir),
    isProduction: config.isProduction,
  });
};

module.exports = { createProvider, createDevProvider, createSmtpProvider };
