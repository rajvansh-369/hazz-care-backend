'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const tokenService = require('../../src/services/token.service');
const tokenTypes = require('../../src/config/tokenTypes');
const config = require('../../src/config/config');
const ApiError = require('../../src/utils/ApiError');

const userId = new mongoose.Types.ObjectId();
const inFiveMinutes = () => new Date(Date.now() + 5 * 60 * 1000);

describe('tokenService (stateless parts)', () => {
  describe('hashToken', () => {
    test('is deterministic and never returns the plaintext', () => {
      const hash = tokenService.hashToken('a-token');
      expect(hash).toBe(tokenService.hashToken('a-token'));
      expect(hash).not.toBe('a-token');
      expect(hash).toHaveLength(64);
    });

    test('produces different hashes for different tokens', () => {
      expect(tokenService.hashToken('one')).not.toBe(tokenService.hashToken('two'));
    });
  });

  describe('generateToken', () => {
    test('embeds subject, type, expiry, issuer and audience', () => {
      const expires = inFiveMinutes();
      const token = tokenService.generateToken(userId, expires, tokenTypes.ACCESS, {
        role: 'user',
      });
      const payload = jwt.decode(token);

      expect(payload.sub).toBe(userId.toString());
      expect(payload.type).toBe(tokenTypes.ACCESS);
      expect(payload.role).toBe('user');
      expect(payload.exp).toBe(Math.floor(expires.getTime() / 1000));
      expect(payload.iss).toBe(config.jwt.issuer);
      expect(payload.aud).toBe(config.jwt.audience);
      expect(payload.jti).toEqual(expect.any(String));
    });

    test('gives every token a unique id', () => {
      const expires = inFiveMinutes();
      const a = jwt.decode(tokenService.generateToken(userId, expires, tokenTypes.ACCESS));
      const b = jwt.decode(tokenService.generateToken(userId, expires, tokenTypes.ACCESS));
      expect(a.jti).not.toBe(b.jti);
    });
  });

  describe('verifyJwt', () => {
    test('accepts a valid token of the expected type', () => {
      const token = tokenService.generateToken(userId, inFiveMinutes(), tokenTypes.ACCESS);
      expect(tokenService.verifyJwt(token, tokenTypes.ACCESS).sub).toBe(userId.toString());
    });

    test('rejects a token of the wrong type', () => {
      const token = tokenService.generateToken(userId, inFiveMinutes(), tokenTypes.REFRESH);
      expect(() => tokenService.verifyJwt(token, tokenTypes.ACCESS)).toThrow(ApiError);
      try {
        tokenService.verifyJwt(token, tokenTypes.ACCESS);
      } catch (error) {
        expect(error.code).toBe('TOKEN_INVALID');
        expect(error.statusCode).toBe(401);
      }
    });

    test('reports an expired token distinctly', () => {
      const token = tokenService.generateToken(
        userId,
        new Date(Date.now() - 1000),
        tokenTypes.ACCESS
      );
      try {
        tokenService.verifyJwt(token, tokenTypes.ACCESS);
        throw new Error('should not reach here');
      } catch (error) {
        expect(error.code).toBe('TOKEN_EXPIRED');
      }
    });

    test('rejects a token signed with another secret', () => {
      const forged = jwt.sign(
        { sub: 'x', type: tokenTypes.ACCESS },
        'another-secret-value-0000000000',
        {
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
          expiresIn: '5m',
        }
      );
      expect(() => tokenService.verifyJwt(forged, tokenTypes.ACCESS)).toThrow(/invalid/i);
    });

    test('rejects a token issued for another audience', () => {
      const foreign = jwt.sign({ sub: 'x', type: tokenTypes.ACCESS }, config.jwt.secret, {
        issuer: config.jwt.issuer,
        audience: 'some-other-audience',
        expiresIn: '5m',
      });
      expect(() => tokenService.verifyJwt(foreign, tokenTypes.ACCESS)).toThrow(ApiError);
    });

    test('rejects the "none" algorithm', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userId.toString(),
          type: tokenTypes.ACCESS,
          iss: config.jwt.issuer,
          aud: config.jwt.audience,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      ).toString('base64url');
      expect(() => tokenService.verifyJwt(`${header}.${payload}.`, tokenTypes.ACCESS)).toThrow(
        ApiError
      );
    });

    test('rejects garbage', () => {
      expect(() => tokenService.verifyJwt('not-a-token', tokenTypes.ACCESS)).toThrow(ApiError);
    });
  });
});
