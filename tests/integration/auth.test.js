'use strict';

const request = require('supertest');
const app = require('../../src/app');
const setupTestDB = require('../utils/setupTestDB');
const { User, Token } = require('../../src/models');
const tokenTypes = require('../../src/config/tokenTypes');
const tokenService = require('../../src/services/token.service');
const config = require('../../src/config/config');
const { userOne, admin, password, insertUsers } = require('../fixtures/user.fixture');
const { userOneAccessToken } = require('../fixtures/token.fixture');

setupTestDB();

const API = config.apiPrefix;

describe('Auth routes', () => {
  describe(`POST ${API}/auth/register`, () => {
    const newUser = () => ({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Str0ng!Pass1',
    });

    test('creates the user, hashes the password and returns a token pair', async () => {
      const body = newUser();
      const res = await request(app).post(`${API}/auth/register`).send(body).expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toEqual({
        id: expect.any(String),
        name: body.name,
        email: body.email,
        role: 'user',
        isEmailVerified: false,
        isActive: true,
        lastLoginAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.body.data.user.password).toBeUndefined();
      expect(res.body.data.tokens.access.token).toEqual(expect.any(String));
      expect(res.body.data.tokens.refresh.token).toEqual(expect.any(String));

      const dbUser = await User.findById(res.body.data.user.id).select('+password');
      expect(dbUser).toBeDefined();
      expect(dbUser.password).not.toBe(body.password);
      expect(dbUser.role).toBe('user');

      const refreshTokens = await Token.countDocuments({
        user: dbUser._id,
        type: tokenTypes.REFRESH,
      });
      expect(refreshTokens).toBe(1);
    });

    test('lowercases and trims the email', async () => {
      const res = await request(app)
        .post(`${API}/auth/register`)
        .send({ ...newUser(), email: '  ADA@Example.COM ' })
        .expect(201);
      expect(res.body.data.user.email).toBe('ada@example.com');
    });

    test.each([
      ['missing name', { email: 'a@b.com', password: 'Str0ng!Pass1' }, 'name'],
      ['invalid email', { name: 'Ada', email: 'not-an-email', password: 'Str0ng!Pass1' }, 'email'],
      ['weak password', { name: 'Ada', email: 'a@b.com', password: 'password' }, 'password'],
      ['short password', { name: 'Ada', email: 'a@b.com', password: 'Ab1!' }, 'password'],
    ])('rejects %s with 400 and a field level detail', async (_label, body, field) => {
      const res = await request(app).post(`${API}/auth/register`).send(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.map((detail) => detail.field)).toContain(field);
      expect(res.body.requestId).toEqual(expect.any(String));
    });

    test('rejects unknown body keys', async () => {
      const res = await request(app)
        .post(`${API}/auth/register`)
        .send({ ...newUser(), role: 'admin' })
        .expect(400);
      expect(res.body.details.map((detail) => detail.field)).toContain('role');
    });

    test('returns 409 when the email is already registered', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/auth/register`)
        .send({ ...newUser(), email: userOne.email })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
    });
  });

  describe(`POST ${API}/auth/login`, () => {
    test('returns the user and a token pair for valid credentials', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(200);

      expect(res.body.data.user.email).toBe(userOne.email);
      expect(res.body.data.user.password).toBeUndefined();
      expect(res.body.data.tokens).toHaveProperty('access');
      expect(res.body.data.tokens).toHaveProperty('refresh');
    });

    test('records the login timestamp', async () => {
      await insertUsers([userOne]);
      await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(200);
      const dbUser = await User.findById(userOne._id);
      expect(dbUser.lastLoginAt).not.toBeNull();
    });

    test('returns 401 for an unknown email', async () => {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: 'nobody@example.com', password })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    test('returns 401 for a wrong password and does not reveal the reason', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password: 'Wr0ng!Pass1' })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.message).toBe('Incorrect email or password');
    });

    test('locks the account after the configured number of failures', async () => {
      await insertUsers([userOne]);
      const attempts = config.security.loginMaxAttempts;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(app)
          .post(`${API}/auth/login`)
          .send({ email: userOne.email, password: 'Wr0ng!Pass1' })
          .expect(401);
      }

      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
    });

    test('returns 403 for a deactivated account', async () => {
      await insertUsers([userOne]);
      await User.updateOne({ _id: userOne._id }, { $set: { isActive: false } });
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe(`POST ${API}/auth/refresh-tokens`, () => {
    const loginAndGetTokens = async () => {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(200);
      return res.body.data.tokens;
    };

    test('rotates the refresh token and issues a new pair', async () => {
      await insertUsers([userOne]);
      const tokens = await loginAndGetTokens();

      const res = await request(app)
        .post(`${API}/auth/refresh-tokens`)
        .send({ refreshToken: tokens.refresh.token })
        .expect(200);

      expect(res.body.data.tokens.refresh.token).not.toBe(tokens.refresh.token);
      const stored = await Token.findOne({
        token: tokenService.hashToken(tokens.refresh.token),
      });
      expect(stored).toBeNull();
    });

    test('rejects a replayed refresh token', async () => {
      await insertUsers([userOne]);
      const tokens = await loginAndGetTokens();

      await request(app)
        .post(`${API}/auth/refresh-tokens`)
        .send({ refreshToken: tokens.refresh.token })
        .expect(200);

      const res = await request(app)
        .post(`${API}/auth/refresh-tokens`)
        .send({ refreshToken: tokens.refresh.token })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    test('rejects an access token used as a refresh token', async () => {
      await insertUsers([userOne]);
      const tokens = await loginAndGetTokens();
      const res = await request(app)
        .post(`${API}/auth/refresh-tokens`)
        .send({ refreshToken: tokens.access.token })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    test('rejects a malformed token', async () => {
      const res = await request(app)
        .post(`${API}/auth/refresh-tokens`)
        .send({ refreshToken: 'not.a.jwt' })
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe(`POST ${API}/auth/logout`, () => {
    test('deletes the session', async () => {
      await insertUsers([userOne]);
      const login = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password });
      const { refresh } = login.body.data.tokens;

      await request(app)
        .post(`${API}/auth/logout`)
        .send({ refreshToken: refresh.token })
        .expect(200);
      expect(await Token.countDocuments({ user: userOne._id, type: tokenTypes.REFRESH })).toBe(0);
    });

    test('returns 404 when the session does not exist', async () => {
      await insertUsers([userOne]);
      const login = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password });
      const { refresh } = login.body.data.tokens;
      await request(app)
        .post(`${API}/auth/logout`)
        .send({ refreshToken: refresh.token })
        .expect(200);
      await request(app)
        .post(`${API}/auth/logout`)
        .send({ refreshToken: refresh.token })
        .expect(404);
    });
  });

  describe(`POST ${API}/auth/logout-all`, () => {
    test('revokes every session of the caller', async () => {
      await insertUsers([userOne]);
      await request(app).post(`${API}/auth/login`).send({ email: userOne.email, password });
      await request(app).post(`${API}/auth/login`).send({ email: userOne.email, password });
      expect(await Token.countDocuments({ user: userOne._id, type: tokenTypes.REFRESH })).toBe(2);

      await request(app)
        .post(`${API}/auth/logout-all`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(200);

      expect(await Token.countDocuments({ user: userOne._id, type: tokenTypes.REFRESH })).toBe(0);
    });
  });

  describe(`GET ${API}/auth/me`, () => {
    test('returns the principal with its rights', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(200);
      expect(res.body.data.user.email).toBe(userOne.email);
      expect(res.body.data.rights).toContain('tasks:manage-own');
    });

    test('returns 401 without a token', async () => {
      const res = await request(app).get(`${API}/auth/me`).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    test('returns 401 for a token signed with a different secret', async () => {
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign(
        { sub: String(userOne._id), type: tokenTypes.ACCESS },
        'a-completely-different-secret-value-000000',
        { issuer: config.jwt.issuer, audience: config.jwt.audience, expiresIn: '5m' }
      );
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    test('returns 401 for an expired token', async () => {
      await insertUsers([userOne]);
      const { expiredAccessTokenFor } = require('../fixtures/token.fixture');
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${expiredAccessTokenFor(userOne)}`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    test('returns 401 when the Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .get(`${API}/auth/me`)
        .set('Authorization', `Basic ${Buffer.from('a:b').toString('base64')}`)
        .expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('Password management', () => {
    test('forgot password issues a reset token, reset password applies it and revokes sessions', async () => {
      await insertUsers([userOne]);
      await request(app).post(`${API}/auth/login`).send({ email: userOne.email, password });

      const forgot = await request(app)
        .post(`${API}/auth/forgot-password`)
        .send({ email: userOne.email })
        .expect(200);
      const resetToken = forgot.body.data.resetToken;
      expect(resetToken).toEqual(expect.any(String));

      const newPassword = 'Rotated!Pass9';
      await request(app)
        .post(`${API}/auth/reset-password`)
        .send({ token: resetToken, password: newPassword })
        .expect(200);

      await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password })
        .expect(401);
      await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password: newPassword })
        .expect(200);
    });

    test('forgot password does not reveal whether an email exists', async () => {
      const res = await request(app)
        .post(`${API}/auth/forgot-password`)
        .send({ email: 'nobody@example.com' })
        .expect(200);
      expect(res.body.data.resetToken).toBeNull();
    });

    test('a reset token cannot be used twice', async () => {
      await insertUsers([userOne]);
      const forgot = await request(app)
        .post(`${API}/auth/forgot-password`)
        .send({ email: userOne.email });
      const { resetToken } = forgot.body.data;

      await request(app)
        .post(`${API}/auth/reset-password`)
        .send({ token: resetToken, password: 'Rotated!Pass9' })
        .expect(200);
      await request(app)
        .post(`${API}/auth/reset-password`)
        .send({ token: resetToken, password: 'Rotated!Pass8' })
        .expect(401);
    });

    test('change password requires the current one and revokes sessions', async () => {
      await insertUsers([userOne]);
      const login = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password });
      const accessToken = login.body.data.tokens.access.token;

      await request(app)
        .post(`${API}/auth/change-password`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'Wr0ng!Pass1', newPassword: 'Changed!Pass7' })
        .expect(401);

      await request(app)
        .post(`${API}/auth/change-password`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: 'Changed!Pass7' })
        .expect(200);

      expect(await Token.countDocuments({ user: userOne._id, type: tokenTypes.REFRESH })).toBe(0);
      await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password: 'Changed!Pass7' })
        .expect(200);
    });

    test('change password rejects reusing the current password', async () => {
      await insertUsers([userOne]);
      const login = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password });
      await request(app)
        .post(`${API}/auth/change-password`)
        .set('Authorization', `Bearer ${login.body.data.tokens.access.token}`)
        .send({ currentPassword: password, newPassword: password })
        .expect(400);
    });
  });

  describe('Email verification', () => {
    test('verifies the email with the token issued at registration', async () => {
      const res = await request(app)
        .post(`${API}/auth/register`)
        .send({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'Str0ng!Pass1' })
        .expect(201);

      const { verifyEmailToken } = res.body.data;
      expect(verifyEmailToken).toEqual(expect.any(String));

      const verified = await request(app)
        .post(`${API}/auth/verify-email`)
        .send({ token: verifyEmailToken })
        .expect(200);
      expect(verified.body.data.user.isEmailVerified).toBe(true);
    });

    test('rejects an unknown verification token', async () => {
      await insertUsers([admin]);
      const orphan = tokenService.generateToken(
        admin._id,
        new Date(Date.now() + 60000),
        tokenTypes.VERIFY_EMAIL
      );
      await request(app).post(`${API}/auth/verify-email`).send({ token: orphan }).expect(401);
    });
  });
});
