'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_NAME_TRIES = 5;

/**
 * Development mail provider: one JSON file per email in EMAIL_DEV_DIR, named
 * `<unix-ms>-<4 random hex>.json`, containing { to, subject, code, text, createdAt }.
 * The random suffix keeps two emails written in the same millisecond apart; the
 * file is opened with 'wx' so even a suffix collision never overwrites.
 *
 * scripts/verify-contract.js reads these files to complete the OTP flow locally.
 *
 * Refuses to run in production: it writes reset codes to disk in clear.
 *
 * @param {{ dir: string, isProduction: boolean }} options
 */
const createDevProvider = ({ dir, isProduction }) => {
  if (isProduction) {
    throw new Error('The dev email provider must never run in production');
  }

  const send = async ({ to, subject, text, code }) => {
    await fs.promises.mkdir(dir, { recursive: true });
    const createdAt = new Date();
    const body = JSON.stringify({ to, subject, code, text, createdAt: createdAt.toISOString() }, null, 2);

    for (let attempt = 1; ; attempt += 1) {
      const name = `${createdAt.getTime()}-${crypto.randomBytes(2).toString('hex')}.json`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.writeFile(path.join(dir, name), body, { flag: 'wx' });
        return { file: path.join(dir, name) };
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt >= MAX_NAME_TRIES) {
          throw error;
        }
      }
    }
  };

  return { name: 'dev', send };
};

module.exports = { createDevProvider };
