'use strict';

/**
 * End-to-end log redaction (CLAUDE.md C3): captures the ACTUAL formatted output of
 * winston and morgan while real requests carry every kind of secret, then asserts
 * none of those values — and no plain email address — appear anywhere in it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const express = require('express');
const request = require('supertest');
const winston = require('winston');

const app = require('../../src/app');
const config = require('../../src/config/config');
const logger = require('../../src/config/logger');
const morgan = require('../../src/config/morgan');
const { PasswordResetOtp, RateLimit, Token, User } = require('../../src/models');
const emailService = require('../../src/services/email.service');
const setupTestDB = require('../utils/setupTestDB');

const AUTH = `${config.apiPrefix}/auth`;
const EMAIL = 'Secret.Pilgrim@Example.com';
const PASSWORD = 'first secret passphrase';
const NEW_PASSWORD = 'second secret passphrase';
const WRONG_PASSWORD = 'not the passphrase at all';

describe('log redaction, end to end', () => {
  setupTestDB();

  const lines = [];
  const capture = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  });
  let devDir;
  let previous;

  // The real app, behind the real morgan request-line loggers (disabled under test).
  const wrapped = express();
  wrapped.use(morgan.successHandler);
  wrapped.use(morgan.errorHandler);
  wrapped.use(app);
  const post = (route, body, headers = {}) =>
    request(wrapped).post(`${AUTH}/${route}`).set(headers).send(body);

  beforeAll(async () => {
    await Promise.all(
      [User, Token, PasswordResetOtp, RateLimit].map((model) => model.createCollection())
    );
    devDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hajjcare-log-redaction-'));
    previous = {
      silent: logger.silent,
      level: logger.level,
      format: logger.format,
      devDir: config.email.devDir,
    };
    config.email.devDir = devDir;
    logger.silent = false;
    logger.level = 'debug';
    logger.add(capture);
  });

  afterAll(async () => {
    await emailService.idle();
    logger.remove(capture);
    logger.silent = previous.silent;
    logger.level = previous.level;
    logger.format = previous.format;
    config.email.devDir = previous.devDir;
    await fs.promises.rm(devDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    lines.length = 0;
    await emailService.idle();
    const names = await fs.promises.readdir(devDir);
    await Promise.all(names.map((name) => fs.promises.rm(path.join(devDir, name))));
  });

  it.each(['developmentFormat', 'productionFormat'])(
    'with the %s, prints no password, OTP code, token, Authorization header or plain email address',
    async (formatName) => {
      logger.format = logger.formats[formatName];
      const secrets = { passwords: [PASSWORD, NEW_PASSWORD, WRONG_PASSWORD], tokens: [] };

      // register + login (right, wrong, unknown)
      const registered = await post('register', {
        email: EMAIL,
        password: PASSWORD,
        fullName: 'Aisha',
      });
      expect(registered.status).toBe(201);
      secrets.tokens.push(registered.body.tokens.accessToken, registered.body.tokens.refreshToken);
      expect((await post('login', { email: EMAIL, password: WRONG_PASSWORD })).status).toBe(401);
      expect(
        (await post('login', { email: 'unknown.person@example.org', password: PASSWORD })).status
      ).toBe(401);
      const loggedIn = await post('login', { email: EMAIL, password: PASSWORD });
      secrets.tokens.push(loggedIn.body.tokens.accessToken, loggedIn.body.tokens.refreshToken);

      // /auth/me with a Bearer header, good and bad
      const me = await request(wrapped)
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${loggedIn.body.tokens.accessToken}`);
      expect(me.status).toBe(200);
      await request(wrapped).get(`${AUTH}/me`).set('Authorization', 'Bearer not.a.jwt');

      // refresh, plus a refresh that fails inside the database (error log with a stack)
      const refreshed = await post('refresh', { refreshToken: loggedIn.body.tokens.refreshToken });
      expect(refreshed.status).toBe(200);
      secrets.tokens.push(refreshed.body.tokens.accessToken, refreshed.body.tokens.refreshToken);
      const dbFailure = Object.assign(
        new Error(`E11000 duplicate key error dup key: { email: "${EMAIL.toLowerCase()}" }`),
        { name: 'MongoServerError', code: 11000, keyValue: { email: EMAIL.toLowerCase() } }
      );
      jest.spyOn(Token, 'findOneAndUpdate').mockRejectedValueOnce(dbFailure);
      expect(
        (await post('refresh', { refreshToken: refreshed.body.tokens.refreshToken })).status
      ).toBe(503);

      // forgot-password → code from the dev email → verify-otp (wrong, then right)
      expect((await post('forgot-password', { email: EMAIL })).status).toBe(200);
      await emailService.idle();
      const [mailFile] = await fs.promises.readdir(devDir);
      const { code } = JSON.parse(await fs.promises.readFile(path.join(devDir, mailFile), 'utf8'));
      const wrongCode = code === '000000' ? '000001' : '000000';
      expect((await post('verify-otp', { email: EMAIL, code: wrongCode })).status).toBe(400);
      const verified = await post('verify-otp', { email: EMAIL, code });
      expect(verified.status).toBe(200);
      const { resetToken } = verified.body;

      // forgot-password failing in the database (error log with a stack)
      jest.spyOn(User, 'findOne').mockImplementationOnce(() => {
        throw dbFailure;
      });
      expect((await post('forgot-password', { email: EMAIL })).status).toBe(503);

      // reset-password: a short password first (422), then the real one
      expect((await post('reset-password', { resetToken, password: 'short' })).status).toBe(422);
      expect((await post('reset-password', { resetToken, password: NEW_PASSWORD })).status).toBe(
        204
      );

      // logout, and a logout whose revoke fails (error log)
      jest.spyOn(Token, 'updateOne').mockRejectedValueOnce(dbFailure);
      expect(
        (await post('logout', { refreshToken: refreshed.body.tokens.refreshToken })).status
      ).toBe(204);

      // a malformed body and an unknown route
      await request(wrapped)
        .post(`${AUTH}/login`)
        .set('Content-Type', 'application/json')
        .send(`{"email":"${EMAIL}","password":"${PASSWORD}"`);
      await post('no-such-route', { email: EMAIL, password: PASSWORD });

      await emailService.idle();
      const output = lines.join('');

      // The capture really saw request lines and error logs.
      expect(output).toMatch(/POST \/api\/v1\/auth\/login 200/);
      expect(output).toMatch(/GET \/api\/v1\/auth\/me 200/);
      expect(output).toMatch(/POST \/api\/v1\/auth\/refresh 503/);
      expect(output).toMatch(/refresh failed/);
      expect(output).toMatch(/MongoServerError/);

      // And none of the secrets.
      const lower = output.toLowerCase();
      [EMAIL, 'unknown.person@example.org'].forEach((address) =>
        expect(lower).not.toContain(address.toLowerCase())
      );
      expect(output).not.toMatch(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i);
      secrets.passwords.forEach((password) => expect(output).not.toContain(password));
      secrets.tokens.forEach((token) => expect(output).not.toContain(token));
      expect(output).not.toContain(resetToken);
      expect(output).not.toMatch(/\brst_/);
      expect(output).not.toMatch(/Bearer /);
      // The OTP code, as a whole six-digit run (a uuid or a timing could contain the digits).
      // eslint-disable-next-line security/detect-non-literal-regexp -- code is six ASCII digits
      expect(output).not.toMatch(new RegExp(`(?<![0-9a-f])${code}(?![0-9a-f])`, 'i'));
    }
  );
});
