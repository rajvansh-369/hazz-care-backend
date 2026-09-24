'use strict';

/**
 * POST /auth/register, POST /auth/login, GET /auth/me against the real app and a
 * real replica set (BACKEND_SPEC.md §3.1, §3.3, §3.4, §3.10; CLAUDE.md A3, A10).
 * These tests encode the client's assumptions, not our implementation.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

const app = require('../../src/app');
const config = require('../../src/config/config');
const { User, Token } = require('../../src/models');
const passwordService = require('../../src/services/password.service');
const setupTestDB = require('../utils/setupTestDB');

const AUTH = `${config.apiPrefix}/auth`;
const PASSWORD = 'correct horse battery';

/** Every response in this file, for the global assertions at the end. */
const seen = [];
const track = (res) => {
  seen.push(res);
  return res;
};

const register = (body) => request(app).post(`${AUTH}/register`).send(body).then(track);
const login = (body) => request(app).post(`${AUTH}/login`).send(body).then(track);
const me = (bearer) => {
  const req = request(app).get(`${AUTH}/me`);
  if (bearer !== undefined) {
    req.set('Authorization', `Bearer ${bearer}`);
  }
  return req.then(track);
};

const validRegistration = (overrides = {}) => ({
  email: 'pilgrim@example.com',
  password: PASSWORD,
  fullName: 'Aisha Rahman',
  ...overrides,
});

const expectAuthUserShape = (user) => {
  expect(Object.keys(user).sort()).toEqual(['email', 'emailVerified', 'fullName', 'id']);
  expect(typeof user.id).toBe('string');
  expect(user.id.trim().length).toBeGreaterThan(0);
  expect(typeof user.email).toBe('string');
  expect(user.fullName === null || typeof user.fullName === 'string').toBe(true);
  expect(user.emailVerified).toBe(true);
};

const expectSessionShape = (body) => {
  expect(Object.keys(body).sort()).toEqual(['tokens', 'user']);
  expect(Object.keys(body.tokens).sort()).toEqual(['accessToken', 'expiresIn', 'refreshToken']);
  expect(typeof body.tokens.accessToken).toBe('string');
  expect(body.tokens.accessToken.length).toBeGreaterThan(0);
  expect(typeof body.tokens.refreshToken).toBe('string');
  expect(body.tokens.refreshToken.length).toBeGreaterThan(0);
  expect(typeof body.tokens.expiresIn).toBe('number');
  expect(body.tokens.expiresIn).toBe(config.jwt.accessTtlSeconds);
  expectAuthUserShape(body.user);
};

const expectFieldError = (res, field, code) => {
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('invalid_input');
  expect(res.body.errors).toEqual(expect.arrayContaining([{ field, code }]));
};

describe('register, login and /auth/me', () => {
  setupTestDB();

  beforeAll(async () => {
    await Promise.all([User.createCollection(), Token.createCollection()]);
    await Promise.all([User.init(), Token.init()]);
  });

  describe('POST /auth/register', () => {
    it('201 with exactly { tokens, user }, well typed', async () => {
      const res = await register(validRegistration());
      expect(res.status).toBe(201);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expectSessionShape(res.body);
      expect(res.body.user.email).toBe('pilgrim@example.com');
      expect(res.body.user.fullName).toBe('Aisha Rahman');
    });

    it('stores an argon2id hash, never the password', async () => {
      await register(validRegistration());
      const stored = await User.findOne({ email: 'pilgrim@example.com' })
        .select('+passwordHash')
        .lean();
      expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    });

    it('stores the user and its first refresh token together', async () => {
      const res = await register(validRegistration());
      await expect(Token.countDocuments({ user: res.body.user.id, type: 'refresh' })).resolves.toBe(
        1
      );
    });

    describe('§3.3 error table', () => {
      it('address already registered → 409 email_taken with field email', async () => {
        await register(validRegistration());
        const res = await register(validRegistration());
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          code: 'email_taken',
          errors: [{ field: 'email', code: 'email_taken' }],
        });
      });

      it('password below the minimum → 422 password_too_short on field password', async () => {
        const res = await register(validRegistration({ password: '1234567' }));
        expect(res.body).toEqual({
          code: 'invalid_input',
          errors: [{ field: 'password', code: 'password_too_short' }],
        });
        expect(res.status).toBe(422);
      });

      it('address rejected → 422 email_invalid on field email', async () => {
        const res = await register(validRegistration({ email: 'not-an-email' }));
        expect(res.body).toEqual({
          code: 'invalid_input',
          errors: [{ field: 'email', code: 'email_invalid' }],
        });
        expect(res.status).toBe(422);
      });

      it('server broke → 5xx (503), never 401/403/409/429', async () => {
        jest.spyOn(User, 'create').mockRejectedValueOnce(new Error('primary stepped down'));
        const res = await register(validRegistration());
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ code: 'unavailable' });
      });
    });

    it('"PILGRIM@X.COM" after "pilgrim@x.com" → 409 email_taken on field email', async () => {
      expect((await register(validRegistration({ email: 'pilgrim@x.com' }))).status).toBe(201);
      const res = await register(validRegistration({ email: 'PILGRIM@X.COM' }));
      expect(res.status).toBe(409);
      expect(res.body.errors).toEqual([{ field: 'email', code: 'email_taken' }]);
    });

    it('two simultaneous registrations for one address: one 201, one 409', async () => {
      const results = await Promise.all([
        register(validRegistration()),
        register(validRegistration({ email: 'Pilgrim@Example.com' })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      await expect(User.countDocuments({})).resolves.toBe(1);
    });

    it('a non-email duplicate key is NOT email_taken → 503', async () => {
      const duplicate = Object.assign(new Error('E11000 duplicate key: tokenHash_1'), {
        code: 11000,
        keyPattern: { tokenHash: 1 },
        keyValue: { tokenHash: 'x' },
      });
      jest.spyOn(Token, 'create').mockRejectedValueOnce(duplicate);
      const res = await register(validRegistration());
      expect(res.status).toBe(503);
      await expect(User.countDocuments({})).resolves.toBe(0);
    });

    it('7 characters → 422 password_too_short; 8 characters → 201', async () => {
      expectFieldError(
        await register(validRegistration({ password: 'abcdefg' })),
        'password',
        'password_too_short'
      );
      expect((await register(validRegistration({ password: 'abcdefgh' }))).status).toBe(201);
    });

    it('8 Arabic letters → 201 (8 by .length)', async () => {
      const arabic = 'كلمةسرية';
      expect(arabic.length).toBe(8);
      const res = await register(validRegistration({ password: arabic }));
      expect(res.status).toBe(201);
      expect((await login({ email: 'pilgrim@example.com', password: arabic })).status).toBe(200);
    });

    it('no composition rules: 8 lowercase letters is fine', async () => {
      expect((await register(validRegistration({ password: 'aaaaaaaa' }))).status).toBe(201);
    });

    it('no maximum: a 1000-character passphrase registers and signs in', async () => {
      const long = 'labbayk '.repeat(125);
      expect((await register(validRegistration({ password: long }))).status).toBe(201);
      expect((await login({ email: 'pilgrim@example.com', password: long })).status).toBe(200);
    });

    it.each([
      ['missing', {}],
      ['null', { password: null }],
      ['a number', { password: 12345678 }],
    ])('password %s → 422 password_too_short', async (_label, override) => {
      const body = validRegistration(override);
      if (!('password' in override)) {
        delete body.password;
      }
      expectFieldError(await register(body), 'password', 'password_too_short');
    });

    it.each([
      ['missing', undefined],
      ['a number', 42],
      ['empty', ''],
      ['no dot in the domain', 'pilgrim@localhost'],
      ['a space inside', 'pil grim@example.com'],
      ['two @', 'a@b@example.com'],
    ])('email %s → 422 email_invalid', async (_label, email) => {
      const body = validRegistration({ email });
      if (email === undefined) {
        delete body.email;
      }
      expectFieldError(await register(body), 'email', 'email_invalid');
    });

    it('accepts what the client accepts: a one-letter TLD and surrounding spaces', async () => {
      const res = await register(validRegistration({ email: '  Pilgrim@X.c  ' }));
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('pilgrim@x.c');
    });

    it('reports every bad field at once', async () => {
      const res = await register({ email: 'nope', password: 'short', fullName: 7 });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([
        { field: 'email', code: 'email_invalid' },
        { field: 'password', code: 'password_too_short' },
        { field: 'fullName', code: 'invalid_input' },
      ]);
    });

    describe('fullName', () => {
      it('null → 201 with fullName null', async () => {
        const res = await register(validRegistration({ fullName: null }));
        expect(res.status).toBe(201);
        expect(res.body.user.fullName).toBeNull();
      });

      it('missing key → 201 with fullName null', async () => {
        const body = validRegistration();
        delete body.fullName;
        const res = await register(body);
        expect(res.status).toBe(201);
        expect(res.body.user).toHaveProperty('fullName', null);
      });

      it('"  Aisha  " → stored and returned as "Aisha"', async () => {
        const res = await register(validRegistration({ fullName: '  Aisha  ' }));
        expect(res.status).toBe(201);
        expect(res.body.user.fullName).toBe('Aisha');
        const stored = await User.findById(res.body.user.id).lean();
        expect(stored.fullName).toBe('Aisha');
      });

      it('only spaces → null', async () => {
        const res = await register(validRegistration({ fullName: '   ' }));
        expect(res.status).toBe(201);
        expect(res.body.user.fullName).toBeNull();
      });

      it('a number → 422 on field fullName', async () => {
        expectFieldError(
          await register(validRegistration({ fullName: 42 })),
          'fullName',
          'invalid_input'
        );
      });

      it('a long or unusual name is never rejected', async () => {
        const name = 'عائشة '.repeat(60).trim();
        const res = await register(validRegistration({ fullName: name }));
        expect(res.status).toBe(201);
        expect(res.body.user.fullName).toBe(name);
      });
    });

    it('unknown extra keys are ignored', async () => {
      const res = await register(
        validRegistration({ role: 'admin', emailVerified: false, termsVersion: 3 })
      );
      expect(res.status).toBe(201);
      expect(res.body.user.emailVerified).toBe(true);
    });

    it('10 rapid registrations → never 429', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => register(validRegistration({ email: `p${i}@x.com` })))
      );
      results.forEach((res) => expect(res.status).toBe(201));
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await register(validRegistration());
    });

    it('200 with exactly { tokens, user }, well typed', async () => {
      const res = await login({ email: 'pilgrim@example.com', password: PASSWORD });
      expect(res.status).toBe(200);
      expectSessionShape(res.body);
    });

    it('sets lastLoginAt', async () => {
      await login({ email: 'pilgrim@example.com', password: PASSWORD });
      const stored = await User.findOne({ email: 'pilgrim@example.com' }).lean();
      expect(stored.lastLoginAt).toBeInstanceOf(Date);
    });

    describe('§3.4 error table', () => {
      it('wrong password → 401 invalid_credentials', async () => {
        const res = await login({ email: 'pilgrim@example.com', password: 'wrong password' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ code: 'invalid_credentials' });
      });

      it('unknown address → 401 invalid_credentials, never 404', async () => {
        const res = await login({ email: 'nobody@example.com', password: PASSWORD });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ code: 'invalid_credentials' });
      });

      it('server broke → 503', async () => {
        jest.spyOn(User, 'findOne').mockImplementationOnce(() => {
          throw new Error('connection reset');
        });
        const res = await login({ email: 'pilgrim@example.com', password: PASSWORD });
        expect(res.status).toBe(503);
      });
    });

    it('unknown email and wrong password → identical status and body', async () => {
      const unknown = await login({ email: 'nobody@example.com', password: PASSWORD });
      const wrong = await login({ email: 'pilgrim@example.com', password: 'wrong password' });
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.text).toBe(wrong.text);
    });

    it('the unknown-address path still runs an argon2id verify (timing)', async () => {
      const verify = jest.spyOn(passwordService, 'verify');
      await login({ email: 'nobody@example.com', password: PASSWORD });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0][0]).toBe(await passwordService.getDummyHash());
    });

    it('register "Pilgrim@X.com", login " pilgrim@x.com " → 200, same id', async () => {
      const reg = await register(validRegistration({ email: 'Pilgrim@X.com' }));
      const res = await login({ email: ' pilgrim@x.com ', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(reg.body.user.id);
    });

    it('the truncation test: 80×"a"+"Y" does not unlock 80×"a"+"X"', async () => {
      const p1 = `${'a'.repeat(80)}X`;
      const p2 = `${'a'.repeat(80)}Y`;
      expect((await register(validRegistration({ email: 'long@x.com', password: p1 }))).status).toBe(
        201
      );
      expect((await login({ email: 'long@x.com', password: p2 })).status).toBe(401);
      expect((await login({ email: 'long@x.com', password: p1 })).status).toBe(200);
    });

    it('leading and trailing spaces are part of the password', async () => {
      const spaced = '  spaced password  ';
      expect(
        (await register(validRegistration({ email: 'spaces@x.com', password: spaced }))).status
      ).toBe(201);
      expect((await login({ email: 'spaces@x.com', password: spaced })).status).toBe(200);
      expect((await login({ email: 'spaces@x.com', password: spaced.trim() })).status).toBe(401);
    });

    it.each([
      ['email missing', { password: PASSWORD }],
      ['password missing', { email: 'pilgrim@example.com' }],
      ['email a number', { email: 1, password: PASSWORD }],
      ['password a number', { email: 'pilgrim@example.com', password: 12345678 }],
      ['empty body', {}],
    ])('%s → 422 invalid_input, no field routing', async (_label, body) => {
      const res = await login(body);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ code: 'invalid_input' });
    });

    it('does not run the email pattern: a stored address that fails it can still sign in', async () => {
      // Seeded directly: an account created before the pattern was enforced.
      await User.collection.insertOne({
        email: 'legacy@localhost',
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: null,
        emailVerified: true,
      });
      const res = await login({ email: 'Legacy@Localhost', password: PASSWORD });
      expect(res.status).toBe(200);
    });

    it('20 rapid failed logins → never 429, never 403', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          login({ email: 'pilgrim@example.com', password: 'wrong password' })
        )
      );
      results.forEach((res) => expect(res.status).toBe(401));
      expect((await login({ email: 'pilgrim@example.com', password: PASSWORD })).status).toBe(200);
    });
  });

  describe('GET /auth/me', () => {
    it('valid token → 200 with a bare AuthUser (no "user" key)', async () => {
      const reg = await register(validRegistration());
      const res = await me(reg.body.tokens.accessToken);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('user');
      expectAuthUserShape(res.body);
      expect(res.body).toEqual(reg.body.user);
    });

    it('no Authorization header → 401', async () => {
      const res = await me();
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });

    it('token for a deleted user → 401', async () => {
      const reg = await register(validRegistration());
      await User.deleteOne({ _id: reg.body.user.id });
      const res = await me(reg.body.tokens.accessToken);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });

    it('token whose sub is not an ObjectId → 401, not 503', async () => {
      const token = jwt.sign({ sub: 'not-an-object-id' }, config.jwt.accessSecret, {
        algorithm: 'HS256',
        expiresIn: 60,
      });
      const res = await me(token);
      expect(res.status).toBe(401);
    });

    it('token whose sub is a well-formed but unknown ObjectId → 401', async () => {
      const token = jwt.sign(
        { sub: new mongoose.Types.ObjectId().toString() },
        config.jwt.accessSecret,
        { algorithm: 'HS256', expiresIn: 60 }
      );
      expect((await me(token)).status).toBe(401);
    });

    it('server broke → 503', async () => {
      const reg = await register(validRegistration());
      jest.spyOn(User, 'findById').mockImplementationOnce(() => {
        throw new Error('connection reset');
      });
      expect((await me(reg.body.tokens.accessToken)).status).toBe(503);
    });
  });

  describe('user.id is one stable string', () => {
    it('the same id from register, login and /auth/me', async () => {
      const reg = await register(validRegistration());
      const log = await login({ email: 'pilgrim@example.com', password: PASSWORD });
      const who = await me(log.body.tokens.accessToken);

      expect(typeof reg.body.user.id).toBe('string');
      expect(log.body.user.id).toBe(reg.body.user.id);
      expect(who.body.id).toBe(reg.body.user.id);
    });
  });

  describe('everything seen in this file', () => {
    it('saw a meaningful number of responses', () => {
      expect(seen.length).toBeGreaterThan(80);
    });

    it('no response body ever contains a passwordHash or an argon2 hash', () => {
      seen.forEach((res) => {
        expect(res.text).not.toContain('passwordHash');
        expect(res.text).not.toContain('$argon2');
      });
    });

    it('none of these routes ever returned 403, 404 or 500', () => {
      seen.forEach((res) => expect([403, 404, 500]).not.toContain(res.status));
    });

    it('register never returned 401 or 429; login never 429', () => {
      seen
        .filter((res) => res.req.path.endsWith('/register'))
        .forEach((res) => expect([401, 429]).not.toContain(res.status));
      seen
        .filter((res) => res.req.path.endsWith('/login'))
        .forEach((res) => expect(res.status).not.toBe(429));
    });

    it('every body is a bare JSON object with camelCase keys and no envelope', () => {
      const walk = (value) => {
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (value && typeof value === 'object') {
          Object.entries(value).forEach(([key, child]) => {
            expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/);
            walk(child);
          });
        }
      };
      seen.forEach((res) => {
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Array.isArray(res.body)).toBe(false);
        expect(res.body).not.toHaveProperty('data');
        expect(res.body).not.toHaveProperty('success');
        walk(res.body);
      });
    });
  });
});
