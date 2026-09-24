'use strict';

/**
 * Wiring contract: framework defaults that would break the Flutter client
 * (CLAUDE.md A3, A10; BACKEND_SPEC.md §2, §3.2). No listening server, no database.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const app = require('../../src/app');
const config = require('../../src/config/config');
const requestId = require('../../src/middlewares/requestId.middleware');
const { errorHandler } = require('../../src/middlewares/error.middleware');
const ApiError = require('../../src/utils/ApiError');

const API = config.apiPrefix;
const AUTH = `${API}/auth`;

/** Every response seen in this file, for the global shape assertions at the end. */
const seen = [];
const track = (res) => {
  seen.push(res);
  return res;
};

const post = (path, body = {}) => request(app).post(path).send(body).then(track);
const getMe = (authorization) => {
  const req = request(app).get(`${AUTH}/me`);
  if (authorization !== undefined) {
    req.set('Authorization', authorization);
  }
  return req.then(track);
};

const signAccess = (claims, options) =>
  jwt.sign(claims, config.jwt.accessSecret, { algorithm: 'HS256', ...options });

/** A tiny app that shares the real request-id, body parser and error handler, with routes that throw. */
const throwingApp = () => {
  const mini = express();
  mini.use(requestId);
  mini.use(express.json({ limit: '32kb' }));
  mini.post(`${AUTH}/boom-plain`, () => {
    throw new Error('boom');
  });
  mini.post(`${AUTH}/boom-duplicate`, () => {
    const error = new Error('E11000 duplicate key error collection: users index: email_1');
    error.name = 'MongoServerError';
    error.code = 11000;
    throw error;
  });
  mini.post(`${AUTH}/boom-validation`, () => {
    const error = new Error('User validation failed');
    error.name = 'ValidationError';
    throw error;
  });
  mini.post(`${AUTH}/boom-404`, () => {
    throw ApiError.notFound();
  });
  mini.post(`${AUTH}/register`, () => {
    throw ApiError.unauthorized();
  });
  mini.post(`${AUTH}/login`, () => {
    throw ApiError.tooManyAttempts();
  });
  mini.post(`${AUTH}/refresh`, () => {
    throw ApiError.unauthorized();
  });
  mini.use(errorHandler);
  return mini;
};

describe('wiring contract', () => {
  describe('no path under the auth router ever 404s', () => {
    test.each([`${AUTH}/does-not-exist`, `${AUTH}/`, `${AUTH}/login/extra`, AUTH])('POST %s', async (path) => {
      const res = await post(path);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });

    test('a wrong method on a real auth path is not 404 either', async () => {
      const res = await request(app).get(`${AUTH}/login`).then(track);
      expect(res.status).toBe(503);
    });
  });

  describe('register, forgot-password, verify-otp, reset-password with {}', () => {
    test.each(['register', 'forgot-password', 'verify-otp', 'reset-password'])('%s is not 401, 403 or 409', async (name) => {
      const res = await post(`${AUTH}/${name}`, {});
      expect([401, 403, 409]).not.toContain(res.status);
    });
  });

  describe('body parsing', () => {
    test('malformed JSON → 400 invalid_input, as JSON', async () => {
      const res = await request(app)
        .post(`${AUTH}/login`)
        .set('Content-Type', 'application/json')
        .send('{"email": "a@b.co", ')
        .then(track);
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ code: 'invalid_input' });
    });

    test('a body over 32kb → 413 invalid_input', async () => {
      const res = await post(`${AUTH}/register`, { fullName: 'x'.repeat(33 * 1024) });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ code: 'invalid_input' });
    });
  });

  describe('error handler defaults', () => {
    const mini = throwingApp();

    test('a plain Error → 503 unavailable', async () => {
      const res = await request(mini).post(`${AUTH}/boom-plain`).then(track);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });

    test('a Mongo 11000 error → 503, not 409', async () => {
      const res = await request(mini).post(`${AUTH}/boom-duplicate`).then(track);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });

    test('a Mongoose ValidationError → 503', async () => {
      const res = await request(mini).post(`${AUTH}/boom-validation`).then(track);
      expect(res.status).toBe(503);
    });

    test.each([
      ['a 404 ApiError under the auth router', 'boom-404'],
      ['a 401 on register', 'register'],
      ['a 429 on login', 'login'],
      ['a 401 on refresh without session_revoked', 'refresh'],
    ])('contract guard: %s → 503', async (_label, path) => {
      const res = await request(mini).post(`${AUTH}/${path}`).then(track);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'unavailable' });
    });
  });

  describe('GET /auth/me authentication', () => {
    test('no Authorization header → 401 unauthorized', async () => {
      const res = await getMe();
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });

    test('garbage token → 401', async () => {
      const res = await getMe('Bearer not-a-jwt');
      expect(res.status).toBe(401);
    });

    test('non-Bearer scheme → 401', async () => {
      const res = await getMe(`Basic ${Buffer.from('a:b').toString('base64')}`);
      expect(res.status).toBe(401);
    });

    test('expired token signed with the real secret → 401', async () => {
      const token = signAccess({ sub: 'user-1' }, { expiresIn: -10 });
      const res = await getMe(`Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    test('token signed with another secret → 401', async () => {
      const token = jwt.sign({ sub: 'user-1' }, 'a-completely-different-secret-of-32-chars!!', {
        algorithm: 'HS256',
      });
      const res = await getMe(`Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    test('token with no subject → 401', async () => {
      const res = await getMe(`Bearer ${signAccess({ foo: 'bar' }, { expiresIn: 60 })}`);
      expect(res.status).toBe(401);
    });

    test('a valid token passes authentication and reaches the stub (503)', async () => {
      const res = await getMe(`Bearer ${signAccess({ sub: 'user-1' }, { expiresIn: 60 })}`);
      expect(res.status).toBe(503);
    });
  });

  describe('every stub answers 503, never 200', () => {
    test.each(['register', 'login', 'refresh', 'forgot-password', 'verify-otp', 'reset-password', 'logout'])(
      'POST %s',
      async (name) => {
        const res = await post(`${AUTH}/${name}`, { email: 'pilgrim@example.com', password: 'long enough' });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ code: 'unavailable' });
      }
    );
  });

  describe('outside the auth router', () => {
    test('GET /api/v1/health → 200', async () => {
      const res = await request(app).get(`${API}/health`).then(track);
      expect(res.status).toBe(200);
    });

    test('GET /api/v1/not-a-route → 404 not_found', async () => {
      const res = await request(app).get(`${API}/not-a-route`).then(track);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: 'not_found' });
    });

    test('no static file serving', async () => {
      const res = await request(app).get('/public/index.html').then(track);
      expect(res.status).toBe(404);
    });
  });

  describe('shape of everything seen above', () => {
    test('no response carries a data or success key', () => {
      expect(seen.length).toBeGreaterThan(20);
      seen.forEach((res) => {
        if (res.body && typeof res.body === 'object') {
          expect(res.body).not.toHaveProperty('data');
          expect(res.body).not.toHaveProperty('success');
        }
      });
    });

    test('every error body is JSON with a string code, and nothing but code/errors', () => {
      seen
        .filter((res) => res.status >= 400)
        .forEach((res) => {
          expect(res.headers['content-type']).toMatch(/application\/json/);
          expect(typeof res.body.code).toBe('string');
          Object.keys(res.body).forEach((key) => expect(['code', 'errors']).toContain(key));
        });
    });

    test('every error response carries an X-Request-Id header', () => {
      seen
        .filter((res) => res.status >= 400)
        .forEach((res) => expect(res.headers['x-request-id']).toEqual(expect.any(String)));
    });

    test('no response is 403 or 500', () => {
      seen.forEach((res) => expect([403, 500]).not.toContain(res.status));
    });
  });
});
