'use strict';

/**
 * Cross-cutting conformance rules that no single route suite owns
 * (CLAUDE.md A1, A2, A3, A10 rules a, r, s; BACKEND_SPEC.md §2, §7).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const app = require('../../src/app');
const config = require('../../src/config/config');
const authRouter = require('../../src/routes/v1/auth.route');
const { PasswordResetOtp, RateLimit, Token, User } = require('../../src/models');
const emailService = require('../../src/services/email.service');
const setupTestDB = require('../utils/setupTestDB');

const API = config.apiPrefix;
const AUTH = `${API}/auth`;
const PASSWORD = 'correct horse battery';

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const walkKeys = (value, visit) => {
  if (Array.isArray(value)) {
    value.forEach((item) => walkKeys(item, visit));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      visit(key);
      walkKeys(child, visit);
    });
  }
};

describe('conformance', () => {
  setupTestDB();

  let devDir;
  let previousDevDir;

  beforeAll(async () => {
    await Promise.all(
      [User, Token, PasswordResetOtp, RateLimit].map((model) => model.createCollection())
    );
    await User.init();
    devDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hajjcare-conformance-'));
    previousDevDir = config.email.devDir;
    config.email.devDir = devDir;
  });

  afterAll(async () => {
    await emailService.idle();
    config.email.devDir = previousDevDir;
    await fs.promises.rm(devDir, { recursive: true, force: true });
  });

  describe('scope and mounting (CLAUDE.md A1, A10 rules r, s)', () => {
    it('routes are mounted under API_PREFIX, which defaults to /api/v1', () => {
      expect(config.apiPrefix).toBe('/api/v1');
    });

    it('the auth router serves exactly the eight contract routes', () => {
      const routes = authRouter.stack
        .filter((layer) => layer.route)
        .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`)
        .sort();
      expect(routes).toEqual(
        [
          'POST /register',
          'POST /login',
          'POST /refresh',
          'POST /forgot-password',
          'POST /verify-otp',
          'POST /reset-password',
          'POST /logout',
          'GET /me',
        ].sort()
      );
    });

    it.each([
      'GET /api/v1/entitlement',
      'GET /api/v1/subscription/entitlement',
      'POST /api/v1/receipts/verify',
      'GET /api/v1/profile',
      'GET /api/v1/health-data',
      'GET /api/v1/passport',
      'GET /api/v1/users',
      'POST /api/v1/auth/otp/request',
    ])('%s does not exist (no entitlement, health-data, profile or phone-OTP endpoint)', async (line) => {
      const [method, url] = line.split(' ');
      const res = await request(app)[method.toLowerCase()](url).send({});
      // Outside /auth an unknown route is 404; under /auth it is the 503 catch-all.
      expect(res.status).toBe(url.startsWith(`${AUTH}/`) ? 503 : 404);
    });

    it('/auth/me does not accept the Authorization header on any other route', async () => {
      // An auth middleware mounted router-wide would turn these into 401s (CLAUDE.md A3.6).
      const garbage = { Authorization: 'Bearer garbage' };
      const cases = [
        ['register', { email: 'a@b.co', password: PASSWORD, fullName: null }, 201],
        ['forgot-password', { email: 'a@b.co' }, 200],
        ['verify-otp', { email: 'a@b.co', code: '123456' }, 400],
        ['reset-password', { resetToken: 'rst_x', password: PASSWORD }, 400],
        ['logout', { refreshToken: 'x' }, 204],
      ];
      for (const [route, body, expected] of cases) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app).post(`${AUTH}/${route}`).set(garbage).send(body);
        expect([route, res.status]).toEqual([route, expected]);
      }
    });
  });

  describe('every response of every route (BACKEND_SPEC.md §2, §7 rules 1-3)', () => {
    const responses = [];
    const keep = (res) => {
      responses.push(res);
      return res;
    };

    beforeAll(async () => {
      await RateLimit.init();
      await Token.init();
    });

    it('collects a success and an error from each route', async () => {
      const post = (route, body) => request(app).post(`${AUTH}/${route}`).send(body).then(keep);
      const reg = await post('register', { email: 'pilgrim@x.com', password: PASSWORD, fullName: 'A' });
      await post('register', { email: 'pilgrim@x.com', password: PASSWORD, fullName: 'A' });
      await post('register', { email: 'bad', password: 'short', fullName: 7 });
      const log = await post('login', { email: 'pilgrim@x.com', password: PASSWORD });
      await post('login', { email: 'pilgrim@x.com', password: 'wrong password' });
      await post('login', {});
      await post('refresh', { refreshToken: log.body.tokens.refreshToken });
      await post('refresh', { refreshToken: 'dead' });
      await post('refresh', {});
      await post('forgot-password', { email: 'pilgrim@x.com' });
      await post('forgot-password', { email: 'nope' });
      await post('verify-otp', { email: 'pilgrim@x.com', code: '000000' });
      await post('verify-otp', { email: 'pilgrim@x.com', code: 'x' });
      await post('reset-password', { resetToken: 'rst_dead', password: PASSWORD });
      await post('logout', { refreshToken: reg.body.tokens.refreshToken });
      await post('no-such-route', {});
      keep(
        await request(app)
          .get(`${AUTH}/me`)
          .set('Authorization', `Bearer ${log.body.tokens.accessToken}`)
      );
      keep(await request(app).get(`${AUTH}/me`));
      keep(await request(app).get(`${API}/health`));
      keep(await request(app).get(`${API}/nothing-here`));
      expect(responses.length).toBeGreaterThan(18);
    });

    it('every body is a bare JSON object (or empty on 204), never an array or envelope', () => {
      responses.forEach((res) => {
        if (res.status === 204) {
          expect(res.text).toBe('');
          return;
        }
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body).toEqual(expect.any(Object));
        expect(Array.isArray(res.body)).toBe(false);
        ['data', 'success', 'result', 'meta'].forEach((key) => expect(res.body).not.toHaveProperty(key));
      });
    });

    it('every key at every depth is camelCase', () => {
      responses.forEach((res) => walkKeys(res.body, (key) => expect(key).toMatch(CAMEL_CASE)));
    });

    it('no _id, __v or passwordHash reaches a response body', () => {
      responses.forEach((res) =>
        walkKeys(res.body, (key) => expect(['_id', '__v', 'passwordHash']).not.toContain(key))
      );
    });

    it('every error carries a known lowercase string code, and field errors are well typed', () => {
      // eslint-disable-next-line global-require
      const known = Object.values(require('../../src/utils/errorCodes'));
      responses
        .filter((res) => res.status >= 400)
        .forEach((res) => {
          expect(known).toContain(res.body.code);
          (res.body.errors || []).forEach((entry) => {
            expect(typeof entry.field).toBe('string');
            expect(known).toContain(entry.code);
            if ('message' in entry) {
              expect(typeof entry.message).toBe('string');
            }
          });
        });
    });

    it('no response is 403 or 500, and no /auth response is 404', () => {
      responses.forEach((res) => {
        expect([403, 500]).not.toContain(res.status);
        if (res.req.path.startsWith(`${AUTH}`)) {
          expect(res.status).not.toBe(404);
        }
      });
    });

    it.each([
      ['If-None-Match', '*'],
      ['If-None-Match', 'W/"anything"'],
      ['If-Modified-Since', 'Wed, 01 Jan 2031 00:00:00 GMT'],
    ])('no 304 with %s: %s (an empty 304 fails the parser)', async (header, value) => {
      // Regression: `If-None-Match: *` produced a 304 with an empty body on GETs.
      const reg = await request(app)
        .post(`${AUTH}/register`)
        .send({ email: 'etag@x.com', password: PASSWORD, fullName: null });
      const me = await request(app)
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${reg.body.tokens.accessToken}`)
        .set(header, value);
      expect(me.status).toBe(200);
      expect(me.body.id).toBe(reg.body.user.id);
      expect(me.headers.etag).toBeUndefined();

      const health = await request(app).get(`${API}/health`).set(header, value);
      expect(health.status).toBe(200);
    });

    it('no response is a redirect', () => {
      responses.forEach((res) => expect(res.status >= 300 && res.status < 400).toBe(false));
    });
  });
});
