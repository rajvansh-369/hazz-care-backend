'use strict';

/**
 * No request that looks like an auth request ever gets a 404 (BACKEND_SPEC.md §3.2,
 * CLAUDE.md A3 landmine 1, A10 f). The client shows any 404 under /auth as "We could not
 * find an account for that email address", and a 404 on forgot-password as a code that
 * was sent. Unknown auth paths and wrong methods answer 503 {"code":"unavailable"}.
 *
 * Every request here goes over a raw socket, so the request target reaches the app
 * exactly as written. No database: no request below reaches a query.
 */

const app = require('../../src/app');
const rawRequest = require('../utils/rawRequest');

describe('no request that looks like /auth ever gets a 404', () => {
  let server;
  let port;
  const seen = [];

  beforeAll((done) => {
    server = app.listen(0, '127.0.0.1', () => {
      ({ port } = server.address());
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });

  const send = async (method, target) => {
    const res = await rawRequest(port, method, target);
    seen.push({ method, target, res });
    return res;
  };
  const expectUnavailable = (res, method) => {
    expect(res.status).toBe(503);
    if (method === 'HEAD') {
      expect(res.text).toBe('');
    } else {
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ code: 'unavailable' });
    }
  };

  describe('answered by the auth router catch-all (unchanged)', () => {
    it.each([
      ['POST', '/api/v1/auth/nope'],
      ['POST', '/api/v1/auth/logn'],
      ['POST', '/api/v1/auth/login/extra'],
      ['POST', '/api/v1/auth/login.json'],
      ['POST', '/api/v1/auth/login;x=1'],
      ['POST', '/api/v1/auth/%ZZ'],
      ['POST', '/api/v1/auth'],
      ['POST', '/api/v1/auth/'],
      ['POST', '/API/V1/AUTH/NOPE'],
      ['POST', '/api/v1/Auth/Nope'],
      ['POST', '/api/v1/auth/nope/'],
      ['POST', '/api/v1/auth/nope//'],
      ['POST', '/api/v1/auth//nope'],
      ['POST', '/api/v1//auth/nope'],
      ['POST', 'http://example.com/api/v1/auth/nope'],
    ])('%s %s → 503 unavailable', async (method, target) => {
      expectUnavailable(await send(method, target), method);
    });
  });

  describe('wrong method on a real auth path → 503, never 404 or 405', () => {
    it.each([
      ['GET', '/api/v1/auth/login'],
      ['GET', '/API/V1/AUTH/LOGIN'],
      ['PUT', '/api/v1/auth/login'],
      ['PATCH', '/api/v1/auth/refresh'],
      ['DELETE', '/api/v1/auth/logout'],
      ['TRACE', '/api/v1/auth/login'],
      ['PROPFIND', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/me'],
      ['GET', '/api/v1/auth/forgot-password'],
      ['GET', '/api/v1/auth'],
      ['HEAD', '/api/v1/auth/login'],
      ['HEAD', '/api/v1/auth/nope'],
    ])('%s %s → 503 unavailable', async (method, target) => {
      expectUnavailable(await send(method, target), method);
    });
  });

  describe('real auth routes through slash and case variants (unchanged)', () => {
    it.each([
      ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/login/'],
      ['POST', '/api/v1/auth/login?x=1'],
      ['POST', '/API/V1/AUTH/LOGIN'],
      ['POST', '/api/v1//auth/login'],
      ['POST', 'http://example.com/api/v1/auth/login'],
    ])('%s %s reaches the login handler → 422 invalid_input for {}', async (method, target) => {
      const res = await send(method, target);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ code: 'invalid_input' });
    });

    it.each(['/api/v1/auth/login', '/api/v1/auth/nope'])(
      'OPTIONS %s → 204 (CORS preflight)',
      async (target) => {
        expect((await send('OPTIONS', target)).status).toBe(204);
      }
    );
  });

  describe('never reached the auth router: 404 before, 503 now', () => {
    it.each([
      // an extra slash before or inside the prefix
      ['POST', '//api/v1/auth/login'],
      ['POST', '//api/v1/auth/nope'],
      ['POST', '/api//v1/auth/login'],
      // dot segments
      ['POST', '/api/v1/./auth/login'],
      ['POST', '/api/v1/./auth/nope'],
      ['POST', '/api/v1/x/../auth/nope'],
      ['POST', '/api/v1/health/../auth/login'],
      // percent-encoding
      ['POST', '/api/v1/%61uth/nope'],
      ['POST', '/api/v1/auth%2Fnope'],
      ['POST', '/api/v1/auth%2Flogin'],
      ['POST', '/api/v1/auth%20/nope'],
      ['POST', '/api/v1/%2e/auth/login'],
      // a backslash
      ['POST', '/api/v1/auth\\nope'],
      ['POST', '/api/v1\\auth\\login'],
      // a wrong base URL in a client build
      ['POST', '/auth/login'],
      ['POST', '/auth/forgot-password'],
      ['POST', '/v1/auth/login'],
      ['POST', '/api/v2/auth/login'],
      ['POST', '/api/v1/api/v1/auth/login'],
      ['POST', 'http://example.com/api/v2/auth/login'],
      ['GET', '/auth/me'],
      ['HEAD', '/api/v2/auth/login'],
    ])('%s %s → 503 unavailable', async (method, target) => {
      expectUnavailable(await send(method, target), method);
    });
  });

  describe('malformed percent-encoding never crashes', () => {
    it.each([
      ['POST', '/api/v2/auth/%ZZ'],
      ['POST', '/api/v2/%61uth/%E0%A4%A'],
      ['POST', '/api/v2/auth/%'],
      ['POST', '/api/v2/auth/%C0%AF'],
      ['POST', '/auth/%FF%FE/login'],
    ])('%s %s (an auth segment) → 503 unavailable', async (method, target) => {
      expectUnavailable(await send(method, target), method);
    });

    it.each([
      ['POST', '/x/%ZZ'],
      ['POST', '/x/%E0%A4%A'],
      ['POST', '/%'],
    ])('%s %s (no auth segment) → 404 not_found', async (method, target) => {
      const res = await send(method, target);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: 'not_found' });
    });
  });

  describe('outside auth (unchanged)', () => {
    it.each([
      ['POST', '/api/v1/not-a-route'],
      ['GET', '/nope'],
      ['GET', '/api/v1/health/nope'],
      ['GET', '/api/v1/webhooks/revenuecat'],
      ['POST', '/api/v1/webhooks/nope'],
      // "auth" must be a whole segment
      ['POST', '/api/v1/auths/login'],
      ['POST', '/api/v1/auth-login'],
      ['POST', '/api/v1/authentication'],
      ['POST', '/api/v1/oauth/login'],
      ['POST', '*'],
    ])('%s %s → 404 not_found', async (method, target) => {
      const res = await send(method, target);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: 'not_found' });
    });

    it('HEAD /nope → 404 with no body', async () => {
      const res = await send('HEAD', '/nope');
      expect(res.status).toBe(404);
      expect(res.text).toBe('');
    });

    it.each(['/health', '/health/live', '/api/v1/health', '/api/v1/health/live'])(
      'GET %s → 200 {"status":"live"}',
      async (target) => {
        const res = await send('GET', target);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'live' });
      }
    );

    it('POST /api/v1/webhooks/revenuecat without credentials → 401, as before', async () => {
      const res = await send('POST', '/api/v1/webhooks/revenuecat');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized' });
    });
  });

  describe('everything seen in this file', () => {
    it('no request with an "auth" segment was ever answered 404', () => {
      const authLike = seen.filter(({ target }) => /(^|[/\\])auth([/\\?;]|$)/i.test(target));
      expect(authLike.length).toBeGreaterThan(50);
      authLike.forEach(({ method, target, res }) => {
        expect(`${method} ${target} → ${res.status}`).not.toMatch(/→ 404$/);
      });
    });
  });
});
