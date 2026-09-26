'use strict';

const { isAuthLikePath } = require('../../src/middlewares/error.middleware');

/**
 * The not-found handler's test for "this was meant for the auth API" (CLAUDE.md A10 f):
 * true answers 503 {"code":"unavailable"} instead of 404.
 */
describe('isAuthLikePath', () => {
  it.each([
    '/api/v1/auth',
    '/api/v1/auth/login',
    '/API/V1/AUTH/LOGIN',
    '//api/v1/auth/login',
    '/api//v1/auth/login',
    '/api/v1/./auth/login',
    '/api/v1/x/../auth/login',
    '/api/v1/health/../auth/login',
    '/api/v1/%61uth/login',
    '/api/v1/%41UTH/login',
    '/api/v1/auth%2Flogin',
    '/api/v1/auth%2flogin',
    '/api/v1/auth%5Clogin',
    '/api/v1/auth%20/login',
    '/api/v1/%2e/auth/login',
    '/api/v1/auth\\login',
    '/api\\v1\\auth\\login',
    '/auth/login',
    '/v1/auth/login',
    '/api/v2/auth/login',
    '/auth',
    '/api/v1/auth?x=/y',
    'http://example.com/api/v2/auth/login',
    'HTTPS://example.com:8443/auth/login',
    // malformed escapes: never a throw, and the auth segment still counts
    '/api/v2/auth/%ZZ',
    '/api/v2/auth/%',
    '/api/v2/%61uth/%E0%A4%A',
    '/api/v2/auth/%C0%AF',
    // raw "auth" that decoding would resolve away still counts
    '/api/v2/auth/%2e%2e/x',
  ])('%s → true', (target) => {
    expect(isAuthLikePath(target)).toBe(true);
  });

  it.each([
    '',
    '/',
    '*',
    '/nope',
    '/api/v1/not-a-route',
    '/api/v1/health',
    '/api/v1/health/nope',
    '/api/v1/webhooks/revenuecat',
    '/api/v1/auths/login',
    '/api/v1/auth-login',
    '/api/v1/authentication',
    '/api/v1/oauth/login',
    '/api/v1/x?next=/auth/login',
    '/api/v1/auth/../x',
    '/x/%ZZ',
    '/%',
  ])('%s → false', (target) => {
    expect(isAuthLikePath(target)).toBe(false);
  });

  it('never throws on any byte sequence', () => {
    const samples = [
      '%',
      '%%',
      '%E0',
      '%E0%A4%A',
      '%FF%FE%FD',
      '\\\\',
      '../../..',
      '%00',
      '\u0000auth',
    ];
    samples.forEach((sample) => {
      expect(() => isAuthLikePath(`/api/${sample}/auth`)).not.toThrow();
      expect(isAuthLikePath(`/api/${sample}/auth`)).toBe(true);
    });
  });
});
