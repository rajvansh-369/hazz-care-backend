'use strict';

/**
 * POST /auth/forgot-password, /auth/verify-otp, /auth/reset-password against the real
 * app and a real replica set (BACKEND_SPEC.md §3.2, §3.6, §3.7, §3.8, §5, §6).
 *
 * None of these three routes may EVER return 401, 403, 404 or 409: a 401/403 reads as
 * "That email and password do not match", and a 404 on forgot-password reads as SUCCESS.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const request = require('supertest');
const app = require('../../src/app');
const config = require('../../src/config/config');
const { PasswordResetOtp, RateLimit, Token, User } = require('../../src/models');
const emailService = require('../../src/services/email.service');
const tokenService = require('../../src/services/token.service');
const authRouter = require('../../src/routes/v1/auth.route');
const setupTestDB = require('../utils/setupTestDB');
const holdNextOtpRead = require('../utils/holdNextOtpRead');

// Dev emails go to a throwaway directory. config is already loaded by the Jest setup
// (the logger requires it), so set it on the object: the mail provider reads
// config.email lazily, on the first send.
const DEV_EMAIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hajjcare-reset-flow-'));
config.email.provider = 'dev';
config.email.devDir = DEV_EMAIL_DIR;

const AUTH = `${config.apiPrefix}/auth`;
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';
const EXPECTED_FORGOT_BODY = { expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 };

/** Every response from the three routes in this file, for the global assertions. */
const seen = [];
const track = (res) => {
  seen.push(res);
  return res;
};

const post = (route, body) => request(app).post(`${AUTH}/${route}`).send(body);
const forgot = (email) => post('forgot-password', { email }).then(track);
const verify = (email, code) => post('verify-otp', { email, code }).then(track);
const reset = (resetToken, password) =>
  post('reset-password', { resetToken, password }).then(track);
const login = (email, password) => post('login', { email, password });
const refresh = (refreshToken) => post('refresh', { refreshToken });

let counter = 0;
const signUp = async () => {
  counter += 1;
  const email = `pilgrim${counter}@x.com`;
  const res = await post('register', { email, password: PASSWORD, fullName: 'Aisha' });
  expect(res.status).toBe(201);
  return { email, ...res.body };
};

const devEmails = async () => {
  await emailService.idle();
  const names = await fs.promises.readdir(DEV_EMAIL_DIR);
  return Promise.all(
    names
      .sort()
      .map(async (name) =>
        JSON.parse(await fs.promises.readFile(path.join(DEV_EMAIL_DIR, name), 'utf8'))
      )
  );
};
const emailsTo = async (to) => (await devEmails()).filter((mail) => mail.to === to);
const latestCodeFor = async (to) => {
  const mails = await emailsTo(to);
  return mails.length ? mails[mails.length - 1].code : null;
};
const otherCode = (code) => (code === '000000' ? '000001' : '000000');
const activeOtp = (email) =>
  PasswordResetOtp.findOne({ email, consumedAt: null, supersededAt: null })
    .sort({ createdAt: -1 })
    .lean();

/** register → forgot → code from the dev email. */
const codeFor = async (email) => {
  expect((await forgot(email)).status).toBe(200);
  const code = await latestCodeFor(email);
  expect(code).toMatch(/^[0-9]{6}$/);
  return code;
};
const resetTokenFor = async (email) => {
  const res = await verify(email, await codeFor(email));
  expect(res.status).toBe(200);
  return res.body.resetToken;
};

const expectInvalidOtp = (res) => {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ code: 'invalid_otp', errors: [{ field: 'code', code: 'invalid_otp' }] });
};
const expectInvalidResetToken = (res) => {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    code: 'invalid_reset_token',
    errors: [{ field: 'resetToken', code: 'invalid_reset_token' }],
  });
};

describe('password reset flow', () => {
  setupTestDB();

  beforeAll(async () => {
    await Promise.all(
      [User, Token, PasswordResetOtp, RateLimit].map((model) => model.createCollection())
    );
    await Promise.all([User.init(), Token.init(), RateLimit.init()]);
  });

  beforeEach(async () => {
    await emailService.idle();
    const names = await fs.promises.readdir(DEV_EMAIL_DIR);
    await Promise.all(names.map((name) => fs.promises.rm(path.join(DEV_EMAIL_DIR, name))));
  });

  afterAll(async () => {
    await emailService.idle();
    await fs.promises.rm(DEV_EMAIL_DIR, { recursive: true, force: true });
  });

  describe('POST /auth/forgot-password', () => {
    it('registered and unregistered addresses → both 200, byte-identical bodies, same content-type', async () => {
      const { email } = await signUp();
      const known = await forgot(email);
      const unknown = await forgot('nobody@x.com');

      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.text).toBe(unknown.text);
      expect(known.headers['content-type']).toBe(unknown.headers['content-type']);
      expect(known.headers['content-type']).toMatch(/application\/json/);
    });

    it('answers exactly { expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 }, all numbers', async () => {
      const res = await forgot('nobody@x.com');
      expect(res.body).toEqual(EXPECTED_FORGOT_BODY);
      Object.values(res.body).forEach((value) => expect(typeof value).toBe('number'));
    });

    it('both paths take at least FORGOT_PASSWORD_MIN_RESPONSE_MS', async () => {
      const { email } = await signUp();
      const floor = config.otp.forgotPasswordMinResponseMs;
      expect(floor).toBeGreaterThan(0);

      for (const address of [email, 'nobody@x.com']) {
        const started = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const res = await forgot(address);
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeGreaterThanOrEqual(floor);
      }
    });

    it('a registered address gets exactly one dev email with a 6-digit code; an unregistered one gets none', async () => {
      const { email } = await signUp();
      await forgot(email);
      await forgot('nobody@x.com');

      const mails = await devEmails();
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toBe(email);
      expect(mails[0].code).toMatch(/^[0-9]{6}$/);
      expect(mails[0].subject).toBe('Your HajjCare password reset code');
    });

    it('matches the address trimmed and case-insensitively', async () => {
      const { email } = await signUp();
      expect((await forgot(`  ${email.toUpperCase()} `)).status).toBe(200);
      expect(await emailsTo(email)).toHaveLength(1);
    });

    it('stores no OTP for an unregistered address', async () => {
      await forgot('nobody@x.com');
      await expect(PasswordResetOtp.countDocuments({})).resolves.toBe(0);
    });

    it('a resend returns the full 600/60/6 again, and only the newest code verifies', async () => {
      const { email } = await signUp();
      const first = await codeFor(email);
      const again = await forgot(email);
      expect(again.body).toEqual(EXPECTED_FORGOT_BODY);
      const second = await latestCodeFor(email);

      if (first !== second) {
        expectInvalidOtp(await verify(email, first));
      }
      expect((await verify(email, second)).status).toBe(200);
    });

    it('the 6th send in an hour → 429, for a registered and an unregistered address alike', async () => {
      const { email } = await signUp();
      const statuses = { known: [], unknown: [] };
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.known.push((await forgot(email)).status);
        // eslint-disable-next-line no-await-in-loop
        statuses.unknown.push((await forgot('nobody@x.com')).status);
      }
      expect(statuses.known).toEqual([200, 200, 200, 200, 200, 429]);
      expect(statuses.unknown).toEqual(statuses.known);

      const limited = await forgot(email);
      expect(limited.body).toEqual({ code: 'too_many_attempts' });
      expect(await emailsTo(email)).toHaveLength(5);
    });

    it.each([
      ['not an address', 'not-an-email'],
      ['missing', undefined],
      ['a number', 42],
      ['empty', ''],
      ['no dot in the domain', 'pilgrim@localhost'],
    ])('email %s → 422 email_invalid', async (_label, email) => {
      const res = await forgot(email);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        code: 'invalid_input',
        errors: [{ field: 'email', code: 'email_invalid' }],
      });
    });

    it('a database failure → 503, for a known and an unknown address', async () => {
      const { email } = await signUp();
      jest.spyOn(User, 'findOne').mockImplementation(() => {
        throw new Error('connection reset');
      });
      for (const address of [email, 'nobody@x.com']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await forgot(address);
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ code: 'unavailable' });
      }
    });

    it('a failing send-limit store → 503, not 200 and not 429', async () => {
      jest.spyOn(RateLimit, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw new Error('connection reset');
      });
      expect((await forgot('nobody@x.com')).status).toBe(503);
    });

    it('never awaits delivery: a hanging email provider does not delay the response', async () => {
      const { email } = await signUp();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const send = jest.fn(() => gate);
      // Swap the service's delivery for one that never finishes on its own.
      jest.spyOn(emailService, 'enqueueOtpEmail').mockImplementation(({ to, code }) => {
        setImmediate(() => send({ to, code }));
      });

      const res = await forgot(email);
      expect(res.status).toBe(200);
      release();
    });
  });

  describe('POST /auth/verify-otp', () => {
    it('the right code → 200 with exactly { resetToken, expiresInSeconds }', async () => {
      const { email } = await signUp();
      const res = await verify(email, await codeFor(email));

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['expiresInSeconds', 'resetToken']);
      expect(res.body.resetToken.startsWith('rst_')).toBe(true);
      expect(res.body.expiresInSeconds).toBe(600);
      expect(typeof res.body.expiresInSeconds).toBe('number');
      ['accessToken', 'refreshToken', 'tokens', 'user'].forEach((key) =>
        expect(res.body).not.toHaveProperty(key)
      );
    });

    it('the reset token is not a session: it does not open /auth/me', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      const res = await request(app).get(`${AUTH}/me`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('a wrong code → 400 invalid_otp with field code', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      expectInvalidOtp(await verify(email, otherCode(code)));
      expect((await activeOtp(email)).attempts).toBe(1);
    });

    it('an unknown address → 400 invalid_otp, never 404', async () => {
      expectInvalidOtp(await verify('nobody@x.com', '123456'));
    });

    it.each([
      ['5 digits', '12345'],
      ['7 digits', '1234567'],
      ['letters', 'abcdef'],
      ['Arabic-Indic digits', '١٢٣٤٥٦'],
      ['a number', 123456],
      ['missing', undefined],
      ['digits with a space', '123 456'],
    ])('a code that is %s → 400 invalid_otp, and no attempt consumed', async (_label, code) => {
      const { email } = await signUp();
      await codeFor(email);
      expectInvalidOtp(await verify(email, code));
      expect((await activeOtp(email)).attempts).toBe(0);
    });

    it('a non-string email → 400 invalid_otp', async () => {
      expectInvalidOtp(await verify(42, '123456'));
    });

    it('an expired code → 400 otp_expired, attempts unchanged', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      await PasswordResetOtp.updateOne(
        { email, consumedAt: null, supersededAt: null },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );

      const res = await verify(email, code);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        code: 'otp_expired',
        errors: [{ field: 'code', code: 'otp_expired' }],
      });
      expect((await activeOtp(email)).attempts).toBe(0);
    });

    it('5 wrong codes, then the RIGHT one → 429 too_many_attempts', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expectInvalidOtp(await verify(email, otherCode(code)));
      }
      const res = await verify(email, code);
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ code: 'too_many_attempts' });
    });

    describe('parallel guesses: never more than 5 compares per code', () => {
      // A real listening server and 200 keep-alive sockets opened in advance, so a burst
      // reaches the app at once. Through supertest (a new connection per request) the
      // requests trickle in, and the burst passes even against the old, racy verify.
      const BURST = 200;
      let server;
      let agent;
      beforeAll((done) => {
        server = app.listen(0, '127.0.0.1', done);
        agent = new http.Agent({ keepAlive: true, maxSockets: BURST });
      });
      afterAll((done) => {
        agent.destroy();
        server.close(done);
      });

      /** POST over the keep-alive agent; resolves to the fields the global checks read. */
      const postRaw = (route, body) =>
        new Promise((resolve, reject) => {
          const data = JSON.stringify(body);
          const routePath = `${AUTH}/${route}`;
          const req = http.request(
            {
              host: '127.0.0.1',
              port: server.address().port,
              agent,
              method: 'POST',
              path: routePath,
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(data),
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: text ? JSON.parse(text) : {},
                  req: { path: routePath },
                })
              );
            }
          );
          req.on('error', reject);
          req.end(data);
        });
      const verifyOn = (email, code) => postRaw('verify-otp', { email, code }).then(track);
      /** Opens every socket the burst will use, with requests that touch no OTP. */
      const warmSockets = () =>
        Promise.all(Array.from({ length: BURST }, () => postRaw('verify-otp', {})));

      const expectLocked = (res) => {
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ code: 'too_many_attempts' });
      };

      it('the RIGHT code, read before 5 wrong codes used every attempt → 429, not 200', async () => {
        const { email } = await signUp();
        const code = await codeFor(email);
        const { read, release } = holdNextOtpRead();
        const right = verifyOn(email, code);
        await read;

        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          expectInvalidOtp(await verifyOn(email, otherCode(code)));
        }
        release();

        expectLocked(await right);
        expect((await activeOtp(email)).attempts).toBe(5);
      });

      it('200 parallel guesses, the RIGHT code in the middle → never more than 5 codes compared', async () => {
        const { email } = await signUp();
        const code = await codeFor(email);
        const middle = BURST / 2;
        const guesses = Array.from({ length: BURST }, (_, i) =>
          i === middle ? code : otherCode(code)
        );
        await warmSockets();
        // Every guess compared against the stored hash goes through timingSafeEqual.
        const compare = jest.spyOn(crypto, 'timingSafeEqual');

        const results = await Promise.all(guesses.map((guess) => verifyOn(email, guess)));

        // The right code may win one of the five attempts (200) or not (429); either way
        // at most five guesses are compared. The racy version compared nearly all of them.
        const compared = compare.mock.calls.length;
        expect(compared).toBeGreaterThan(0);
        expect(compared).toBeLessThanOrEqual(5);
        expect((await PasswordResetOtp.findOne({ email }).lean()).attempts).toBe(compared);

        expect([200, 429]).toContain(results[middle].status);
        const others = results.filter((_, i) => i !== middle);
        others.filter((res) => res.status === 400).forEach(expectInvalidOtp);
        others.filter((res) => res.status !== 400).forEach(expectLocked);
      });
    });

    it('after a lockout, a resend → the new code works', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await verify(email, otherCode(code));
      }
      expect((await verify(email, code)).status).toBe(429);

      const fresh = await codeFor(email);
      expect((await verify(email, fresh)).status).toBe(200);
    });

    it('the same code verified twice → the second is 400 invalid_otp', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      expect((await verify(email, code)).status).toBe(200);
      expectInvalidOtp(await verify(email, code));
    });

    it('issuing the reset token fails after the code was consumed → 503', async () => {
      const { email } = await signUp();
      const code = await codeFor(email);
      jest.spyOn(tokenService, 'issueResetToken').mockRejectedValueOnce(new Error('write failed'));
      const res = await verify(email, code);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });
  });

  describe('POST /auth/reset-password', () => {
    it('a valid token + an 8-character password → 204 with an empty body', async () => {
      const { email } = await signUp();
      const res = await reset(await resetTokenFor(email), 'abcdefgh');
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('afterwards the old password → 401 on login, the new one → 200', async () => {
      const { email } = await signUp();
      expect((await reset(await resetTokenFor(email), NEW_PASSWORD)).status).toBe(204);

      const old = await login(email, PASSWORD);
      expect(old.status).toBe(401);
      expect(old.body).toEqual({ code: 'invalid_credentials' });
      expect((await login(email, NEW_PASSWORD)).status).toBe(200);
    });

    it('afterwards every refresh token the user held → 401, used or not, in every family', async () => {
      const registered = await signUp();
      const other = await login(registered.email, PASSWORD);
      const rotated = await refresh(other.body.tokens.refreshToken);
      expect(rotated.status).toBe(200);

      expect((await reset(await resetTokenFor(registered.email), NEW_PASSWORD)).status).toBe(204);

      for (const token of [
        registered.tokens.refreshToken,
        other.body.tokens.refreshToken, // used, child unused: it could still mint a sibling
        rotated.body.tokens.refreshToken,
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const res = await refresh(token);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ code: 'session_revoked' });
      }
    });

    it('the same reset token a second time → 400 invalid_reset_token', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
      expectInvalidResetToken(await reset(token, 'yet another password'));
    });

    it('two concurrent resets with the same token → exactly one 204, one 400', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      const results = await Promise.all([
        reset(token, 'first new password'),
        reset(token, 'second new password'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
      expectInvalidResetToken(results.find((r) => r.status === 400));
    });

    it('an unknown token → 400 invalid_reset_token', async () => {
      expectInvalidResetToken(await reset('rst_never-issued', NEW_PASSWORD));
    });

    it('an expired token → 400 invalid_reset_token', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      await Token.updateOne(
        { type: 'resetPassword', consumedAt: null },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );
      expectInvalidResetToken(await reset(token, NEW_PASSWORD));
    });

    it.each([
      ['""', ''],
      ['missing', undefined],
      ['a number', 42],
      ['null', null],
      ['an object', { $ne: null }],
    ])('resetToken %s → 400 invalid_reset_token', async (_label, token) => {
      expectInvalidResetToken(await reset(token, NEW_PASSWORD));
    });

    it('a dead token is reported before a short password', async () => {
      expectInvalidResetToken(await reset('rst_never-issued', 'short'));
    });

    it('a 7-character password with a valid token → 422 password_too_short; the token still works', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);

      const res = await reset(token, 'abcdefg');
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        code: 'invalid_input',
        errors: [{ field: 'password', code: 'password_too_short' }],
      });
      expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
    });

    it.each([
      ['missing', undefined],
      ['a number', 12345678],
    ])('a password that is %s → 422 password_too_short', async (_label, password) => {
      const { email } = await signUp();
      const res = await reset(await resetTokenFor(email), password);
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([{ field: 'password', code: 'password_too_short' }]);
    });

    it('leading/trailing spaces are stored exactly', async () => {
      const { email } = await signUp();
      const spaced = '  spaced new password  ';
      expect((await reset(await resetTokenFor(email), spaced)).status).toBe(204);
      expect((await login(email, spaced)).status).toBe(200);
      expect((await login(email, spaced.trim())).status).toBe(401);
    });

    it("a reset token issued for user A cannot change user B's password", async () => {
      const a = await signUp();
      const b = await signUp();
      expect((await reset(await resetTokenFor(a.email), NEW_PASSWORD)).status).toBe(204);

      expect((await login(b.email, PASSWORD)).status).toBe(200);
      expect((await login(b.email, NEW_PASSWORD)).status).toBe(401);
      expect((await login(a.email, NEW_PASSWORD)).status).toBe(200);
    });

    it('after a reset, an OTP code issued before it → 400 invalid_otp', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      const pending = await codeFor(email); // a second code, requested before the reset
      expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
      expectInvalidOtp(await verify(email, pending));
    });

    it('a user deleted between verify and reset → 400 invalid_reset_token', async () => {
      const { email, user } = await signUp();
      const token = await resetTokenFor(email);
      await User.deleteOne({ _id: user.id });
      expectInvalidResetToken(await reset(token, NEW_PASSWORD));
    });

    it('a database failure inside the transaction → 503, and nothing changed', async () => {
      const { email } = await signUp();
      const token = await resetTokenFor(email);
      jest.spyOn(Token, 'updateMany').mockRejectedValueOnce(new Error('connection reset'));

      const res = await reset(token, NEW_PASSWORD);
      expect(res.status).toBe(503);
      expect((await login(email, PASSWORD)).status).toBe(200);
      expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
    });

    it('has no rate limiter', () => {
      const layer = authRouter.stack.find((l) => l.route && l.route.path === '/reset-password');
      expect(layer.route.stack).toHaveLength(1);
    });
  });

  describe('end to end', () => {
    it('register → forgot → code from the dev email → verify → reset → login, one user.id throughout', async () => {
      const registered = await signUp();

      const forgotRes = await forgot(registered.email);
      expect(forgotRes.status).toBe(200);
      const [mail] = await emailsTo(registered.email);
      expect(mail.code).toMatch(/^[0-9]{6}$/);

      const verifyRes = await verify(registered.email, mail.code);
      expect(verifyRes.status).toBe(200);

      const resetRes = await reset(verifyRes.body.resetToken, NEW_PASSWORD);
      expect(resetRes.status).toBe(204);

      const loginRes = await login(registered.email, NEW_PASSWORD);
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.id).toBe(registered.user.id);

      const me = await request(app)
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${loginRes.body.tokens.accessToken}`);
      expect(me.body.id).toBe(registered.user.id);
    });
  });

  describe('everything seen in this file', () => {
    it('saw every route many times', () => {
      const count = (route) => seen.filter((res) => res.req.path.endsWith(route)).length;
      expect(count('/forgot-password')).toBeGreaterThan(20);
      expect(count('/verify-otp')).toBeGreaterThan(20);
      expect(count('/reset-password')).toBeGreaterThan(15);
    });

    it('none of the three routes ever returned 401, 403, 404, 409 or 500', () => {
      seen.forEach((res) => expect([401, 403, 404, 409, 500]).not.toContain(res.status));
    });

    it('every error body has a string code, and nothing has an envelope', () => {
      seen.forEach((res) => {
        if (res.status >= 400) {
          expect(res.headers['content-type']).toMatch(/application\/json/);
          expect(typeof res.body.code).toBe('string');
          Object.keys(res.body).forEach((key) => expect(['code', 'errors']).toContain(key));
        }
        if (res.body && typeof res.body === 'object') {
          expect(res.body).not.toHaveProperty('data');
          expect(res.body).not.toHaveProperty('success');
        }
      });
    });
  });
});
