'use strict';

const nodemailer = require('nodemailer');

/**
 * SMTP mail provider (nodemailer), configured from SMTP_URL and EMAIL_FROM.
 * `code` is part of the shared provider interface but is not needed here: it is
 * already in the rendered text and html.
 *
 * @param {{ url: string, from: string }} options
 */
const createSmtpProvider = ({ url, from }) => {
  const transport = nodemailer.createTransport(url);

  const send = async ({ to, subject, text, html }) => {
    const info = await transport.sendMail({ from, to, subject, text, html });
    return { messageId: info && info.messageId };
  };

  return { name: 'smtp', send };
};

module.exports = { createSmtpProvider };
