'use strict';

/**
 * POST /auth/refresh and POST /auth/logout against the real app and a real replica
 * set (BACKEND_SPEC.md §3.5, §3.9, §4; CLAUDE.md A3, A7, A10 rules d, l, p).
 *
 * /auth/refresh is the one response in the API that can sign a pilgrim out: a 401 or
 * 403 with a JSON content type ends the session, even with no body.
 */

const express = require('express');
const request = require('supertest');

const app = require('../../src/app');
const config = require('../../src/config/config');
const logger = require('../../src/config/logger');
const authController = require('../../src/controllers/auth.controller');
const { errorHandler } = require('../../src/middlewares/error.middleware');
const {
  createIpLimiter,
  refreshLimiter,
} = require('../../src/middlewares/rateLimiter.middleware');
const requestId = require('../../src/middlewares/requestId.middleware');
const authRouter = require('../../src/routes/v1/auth.route');
const { User, Token } = require('../../src/models');
const tokenService = require('../../src/services/token.service');
const setupTestDB = require('../utils/setupTestDB');

const AUTH = `${config.apiPrefix}/auth`;
const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery';

/** Every /refresh and /logout response in this file, for the global assertions. */
const refreshSeen = [];
const logoutSeen = [];

const refresh = (body) =>
  request(app)
    .post(`${AUTH}/refresh`)
    .send(body)
    .then((res) => {
      refreshSeen.push(res);
      return res;
    });

const logoutWith = (build) =>
  build(request(app).post(`${AUTH}/logout`)).then((res) => {
    logoutSeen.push(res);
    return res;
  });
const logout = (body) => logoutWith((req) => req.send(body));

const me = (accessToken) =>
  request(app).get(`${AUTH}/me`).set('Authorization', `Bearer ${accessToken}`);

let emailCounter = 0;
const signUp = async () => {
  emailCounter += 1;
  const res = await request(app)
    .post(`${AUTH}/register`)
    .send({ email: `pilgrim${emailCounter}@x.com`, password: PASSWORD, fullName: null });
  expect(res.status).toBe(201);
  return res.body;
};
const signIn = async (email) => {
  const res = await request(app).post(`${AUTH}/login`).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body;
};

const expectSessionRevoked = (res) => {
  expect(res.status).toBe(401);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body).toEqual({ code: 'session_revoked' });
};

describe('refresh and logout', () => {
  setupTestDB();

  beforeAll(async () => {
    await Promise.all([User.createCollection(), Token.createCollection()]);
    await Promise.all([User.init(), Token.init()]);
  });

  describe('POST /auth/refresh', () => {
    it('a valid token → 200 with exactly { tokens: { accessToken, refreshToken, expiresIn } }', async () => {
      const session = await signUp();
      const res = await refresh({ refreshToken: session.tokens.refreshToken });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(Object.keys(res.body)).toEqual(['tokens']);
      expect(res.body).not.toHaveProperty('user');
      expect(Object.keys(res.body.tokens).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
      ]);
      expect(typeof res.body.tokens.accessToken).toBe('string');
      expect(typeof res.body.tokens.refreshToken).toBe('string');
      expect(typeof res.body.tokens.expiresIn).toBe('number');
      expect(res.body.tokens.expiresIn).toBe(config.jwt.accessTtlSeconds);
      expect(res.body.tokens.refreshToken).not.toBe(session.tokens.refreshToken);
    });

    it('the new access token works on /auth/me; the new refresh token refreshes again', async () => {
      const session = await signUp();
      const first = await refresh({ refreshToken: session.tokens.refreshToken });

      const who = await me(first.body.tokens.accessToken);
      expect(who.status).toBe(200);
      expect(who.body.id).toBe(session.user.id);

      const second = await refresh({ refreshToken: first.body.tokens.refreshToken });
      expect(second.status).toBe(200);
    });

    it('the old token inside the grace window → 200, and the first successor still refreshes', async () => {
      const session = await signUp();
      const successor = await refresh({ refreshToken: session.tokens.refreshToken });
      expect(successor.status).toBe(200);

      const retry = await refresh({ refreshToken: session.tokens.refreshToken });
      expect(retry.status).toBe(200);

      expect((await refresh({ refreshToken: successor.body.tokens.refreshToken })).status).toBe(
        200
      );
      expect((await refresh({ refreshToken: retry.body.tokens.refreshToken })).status).toBe(200);
    });

    it('two simultaneous refreshes of one token → both 200, and both new tokens work', async () => {
      const session = await signUp();
      const results = await Promise.all([
        refresh({ refreshToken: session.tokens.refreshToken }),
        refresh({ refreshToken: session.tokens.refreshToken }),
      ]);
      results.forEach((res) => expect(res.status).toBe(200));
      expect(results[0].body.tokens.refreshToken).not.toBe(results[1].body.tokens.refreshToken);

      const followUps = await Promise.all(
        results.map((res) => refresh({ refreshToken: res.body.tokens.refreshToken }))
      );
      followUps.forEach((res) => expect(res.status).toBe(200));
    });

    describe('a genuinely dead token → 401 session_revoked, as JSON', () => {
      it('unknown', async () => {
        expectSessionRevoked(await refresh({ refreshToken: 'never-issued-token' }));
      });

      it('expired', async () => {
        const session = await signUp();
        const past = createPastService(config.tokens.refreshTtlDays * DAY + DAY);
        const stale = await past.issuePair(session.user.id);
        expectSessionRevoked(await refresh({ refreshToken: stale.refreshToken }));
      });

      it('after logout', async () => {
        const session = await signUp();
        expect((await logout({ refreshToken: session.tokens.refreshToken })).status).toBe(204);
        expectSessionRevoked(await refresh({ refreshToken: session.tokens.refreshToken }));
      });

      it('after revokeAllForUser', async () => {
        const session = await signUp();
        await tokenService.revokeAllForUser(session.user.id, 'PASSWORD_RESET');
        expectSessionRevoked(await refresh({ refreshToken: session.tokens.refreshToken }));
      });

      it('a reset token ("rst_...") used as a refresh token', async () => {
        const session = await signUp();
        const resetToken = await tokenService.issueResetToken(session.user.id);
        expect(resetToken.startsWith('rst_')).toBe(true);
        expectSessionRevoked(await refresh({ refreshToken: resetToken }));
      });

      it('an access token (JWT) used as a refresh token', async () => {
        const session = await signUp();
        expectSessionRevoked(await refresh({ refreshToken: session.tokens.accessToken }));
      });

      it('a deleted user', async () => {
        const session = await signUp();
        await User.deleteOne({ _id: session.user.id });
        expectSessionRevoked(await refresh({ refreshToken: session.tokens.refreshToken }));
      });
    });

    describe('a bad body → 400 invalid_input, never 401 or 403', () => {
      it.each([
        ['{}', {}],
        ['a number', { refreshToken: 12345 }],
        ['an object', { refreshToken: { $ne: null } }],
        ['null', { refreshToken: null }],
        ['""', { refreshToken: '' }],
        ['an array', { refreshToken: ['x'] }],
      ])('refreshToken %s', async (_label, body) => {
        const res = await refresh(body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'invalid_input' });
      });

      it('no body at all', async () => {
        const res = await request(app).post(`${AUTH}/refresh`);
        refreshSeen.push(res);
        expect(res.status).toBe(400);
      });

      it('malformed JSON → 400, not 401', async () => {
        const res = await request(app)
          .post(`${AUTH}/refresh`)
          .set('Content-Type', 'application/json')
          .send('{"refreshToken": ');
        refreshSeen.push(res);
        expect(res.status).toBe(400);
      });
    });

    describe('infrastructure failure → 503, never 401', () => {
      it('a database failure inside rotate', async () => {
        const session = await signUp();
        jest.spyOn(Token, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection reset'));
        const res = await refresh({ refreshToken: session.tokens.refreshToken });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ code: 'unavailable' });

        // The session is untouched: the same token still refreshes once the database is back.
        expect((await refresh({ refreshToken: session.tokens.refreshToken })).status).toBe(200);
      });

      it('a failure starting the transaction', async () => {
        const session = await signUp();
        jest.spyOn(tokenService, 'rotate').mockImplementationOnce(() => {
          throw new Error('synchronous surprise');
        });
        const res = await refresh({ refreshToken: session.tokens.refreshToken });
        expect(res.status).toBe(503);
      });

      it('logs the failure without the token value', async () => {
        const session = await signUp();
        const log = jest.spyOn(logger, 'error');
        jest.spyOn(Token, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection reset'));
        await refresh({ refreshToken: session.tokens.refreshToken });

        expect(log).toHaveBeenCalled();
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).not.toContain(session.tokens.refreshToken);
      });
    });

    describe('rate limiting', () => {
      const limitedApp = (limiter) => {
        const mini = express();
        mini.set('trust proxy', config.trustProxy);
        mini.use(requestId);
        mini.use(express.json());
        mini.post(`${AUTH}/refresh`, limiter, authController.refresh);
        mini.use(errorHandler);
        return mini;
      };

      it('over the limit → 429 JSON {code:"too_many_attempts"}, never 401', async () => {
        const mini = limitedApp(createIpLimiter({ limit: 2, skip: () => false }));
        const statuses = [];
        for (let i = 0; i < 4; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const res = await request(mini).post(`${AUTH}/refresh`).send({ refreshToken: 'x' });
          refreshSeen.push(res);
          statuses.push(res.status);
          if (res.status === 429) {
            expect(res.headers['content-type']).toMatch(/application\/json/);
            expect(res.body).toEqual({ code: 'too_many_attempts' });
          }
        }
        expect(statuses).toEqual([401, 401, 429, 429]);
      });

      it('a failing limiter store lets the request through', async () => {
        // express-rate-limit reports the store error on console.error; expected here.
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const brokenStore = {
          init: () => undefined,
          increment: async () => {
            throw new Error('store down');
          },
          decrement: async () => undefined,
          resetKey: async () => undefined,
        };
        const mini = limitedApp(
          createIpLimiter({ limit: 1, skip: () => false, store: brokenStore })
        );
        const session = await signUp();
        const res = await request(mini)
          .post(`${AUTH}/refresh`)
          .send({ refreshToken: session.tokens.refreshToken });
        refreshSeen.push(res);
        expect(res.status).toBe(200);
        expect(consoleError).toHaveBeenCalled();
      });

      it('the production limiter is generous: RATE_LIMIT_IP_PER_HOUR per hour', () => {
        expect(config.rateLimit.ipPerHour).toBeGreaterThanOrEqual(300);
      });

      describe('attached to /refresh only', () => {
        const handlersFor = (method, path) => {
          const layer = authRouter.stack.find(
            (l) => l.route && l.route.path === path && l.route.methods[method]
          );
          return layer.route.stack.map((s) => s.handle);
        };

        it('/refresh has the limiter', () => {
          expect(handlersFor('post', '/refresh')).toContain(refreshLimiter);
        });

        it.each(['/login', '/register', '/logout'])('%s has no limiter', (path) => {
          const handlers = handlersFor('post', path);
          expect(handlers).toHaveLength(1);
          expect(handlers).not.toContain(refreshLimiter);
        });

        it('nothing is mounted router-wide except the 503 catch-all', () => {
          const routerWide = authRouter.stack.filter((l) => !l.route);
          expect(routerWide).toHaveLength(1);
        });
      });
    });
  });

  describe('POST /auth/logout', () => {
    it('a valid token → 204, empty body; refreshing with it afterwards → 401', async () => {
      const session = await signUp();
      const res = await logout({ refreshToken: session.tokens.refreshToken });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expectSessionRevoked(await refresh({ refreshToken: session.tokens.refreshToken }));

      const stored = await Token.findOne({ user: session.user.id, type: 'refresh' }).lean();
      expect(stored.revokedReason).toBe('LOGOUT');
    });

    it('the same token twice → 204 both times', async () => {
      const session = await signUp();
      expect((await logout({ refreshToken: session.tokens.refreshToken })).status).toBe(204);
      expect((await logout({ refreshToken: session.tokens.refreshToken })).status).toBe(204);
    });

    it.each([
      ['""', { refreshToken: '' }],
      ['unknown', { refreshToken: 'never-issued' }],
      ['null', { refreshToken: null }],
      ['a number', { refreshToken: 42 }],
      ['an object', { refreshToken: { $ne: null } }],
      ['{}', {}],
    ])('refreshToken %s → 204', async (_label, body) => {
      const res = await logout(body);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('an expired token → 204', async () => {
      const session = await signUp();
      const stale = await createPastService(61 * DAY).issuePair(session.user.id);
      expect((await logout({ refreshToken: stale.refreshToken })).status).toBe(204);
    });

    it('no body at all → 204', async () => {
      expect((await logoutWith((req) => req)).status).toBe(204);
    });

    it('no JSON Content-Type → 204', async () => {
      const res = await logoutWith((req) =>
        req.set('Content-Type', 'text/plain').send('refreshToken=abc')
      );
      expect(res.status).toBe(204);
    });

    it('malformed JSON → 204', async () => {
      const res = await logoutWith((req) =>
        req.set('Content-Type', 'application/json').send('{"refreshToken": ')
      );
      expect(res.status).toBe(204);
    });

    it('an oversized body → 204', async () => {
      const res = await logout({ refreshToken: 'x'.repeat(40 * 1024) });
      expect(res.status).toBe(204);
    });

    it('a database failure inside revoke → still 204', async () => {
      const session = await signUp();
      jest.spyOn(Token, 'updateOne').mockRejectedValueOnce(new Error('connection reset'));
      const res = await logout({ refreshToken: session.tokens.refreshToken });
      expect(res.status).toBe(204);
    });

    it('ignores the Authorization header entirely', async () => {
      const session = await signUp();
      const res = await logoutWith((req) =>
        req
          .set('Authorization', 'Bearer garbage')
          .send({ refreshToken: session.tokens.refreshToken })
      );
      expect(res.status).toBe(204);
    });

    it("one device's logout does not affect another device's session", async () => {
      const registered = await signUp();
      const phone = await signIn(registered.user.email);
      const tablet = await signIn(registered.user.email);

      expect((await logout({ refreshToken: phone.tokens.refreshToken })).status).toBe(204);

      expectSessionRevoked(await refresh({ refreshToken: phone.tokens.refreshToken }));
      expect((await refresh({ refreshToken: tablet.tokens.refreshToken })).status).toBe(200);
      expect((await refresh({ refreshToken: registered.tokens.refreshToken })).status).toBe(200);
    });

    it('10 rapid logouts → never 429', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => logout({ refreshToken: 'whatever' }))
      );
      results.forEach((res) => expect(res.status).toBe(204));
    });
  });

  describe('everything seen in this file', () => {
    it('refresh never returned 403, 404 or 500, and every 401 was session_revoked JSON', () => {
      expect(refreshSeen.length).toBeGreaterThan(30);
      refreshSeen.forEach((res) => {
        expect([403, 404, 500]).not.toContain(res.status);
        if (res.status === 401) {
          expect(res.headers['content-type']).toMatch(/application\/json/);
          expect(res.body).toEqual({ code: 'session_revoked' });
        }
      });
    });

    it('refresh only ever answered 200, 400, 401, 429 or 503', () => {
      refreshSeen.forEach((res) => expect([200, 400, 401, 429, 503]).toContain(res.status));
    });

    it('logout only ever answered 204 with an empty body', () => {
      expect(logoutSeen.length).toBeGreaterThan(15);
      logoutSeen.forEach((res) => {
        expect(res.status).toBe(204);
        expect(res.text).toBe('');
      });
    });
  });
});

/** A token service whose clock is `ago` milliseconds in the past. */
function createPastService(ago) {
  return tokenService.createTokenService({ now: () => new Date(Date.now() - ago) });
}
