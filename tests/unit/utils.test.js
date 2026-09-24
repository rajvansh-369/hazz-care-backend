'use strict';

const ApiError = require('../../src/utils/ApiError');
const errorCodes = require('../../src/utils/errorCodes');
const catchAsync = require('../../src/utils/catchAsync');
const { sendJson, sendNoContent } = require('../../src/utils/respond');

describe('errorCodes', () => {
  test('is exactly the client contract codes, all lowercase', () => {
    expect(Object.values(errorCodes).sort()).toEqual(
      [
        'email_taken',
        'invalid_credentials',
        'account_not_found',
        'invalid_reset_token',
        'too_many_attempts',
        'otp_expired',
        'invalid_otp',
        'invalid_input',
        'password_too_short',
        'email_invalid',
        'session_revoked',
        'unauthorized',
        'unavailable',
        'not_found',
      ].sort()
    );
  });
});

describe('ApiError', () => {
  test.each([
    ['emailTaken', 409, 'email_taken', [{ field: 'email', code: 'email_taken' }]],
    ['invalidCredentials', 401, 'invalid_credentials', []],
    ['passwordTooShort', 422, 'invalid_input', [{ field: 'password', code: 'password_too_short' }]],
    ['emailInvalid', 422, 'invalid_input', [{ field: 'email', code: 'email_invalid' }]],
    ['invalidOtp', 400, 'invalid_otp', [{ field: 'code', code: 'invalid_otp' }]],
    ['otpExpired', 400, 'otp_expired', [{ field: 'code', code: 'otp_expired' }]],
    ['invalidResetToken', 400, 'invalid_reset_token', [{ field: 'resetToken', code: 'invalid_reset_token' }]],
    ['tooManyAttempts', 429, 'too_many_attempts', []],
    ['unauthorized', 401, 'unauthorized', []],
  ])('%s() → %d %s', (factory, status, code, fieldErrors) => {
    const error = ApiError[factory]();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.fieldErrors).toEqual(fieldErrors);
  });

  test('never produces 403 or 500', () => {
    const factories = Object.getOwnPropertyNames(ApiError).filter((name) => typeof ApiError[name] === 'function');
    factories.forEach((name) => expect([403, 500]).not.toContain(ApiError[name]().status));
  });

  test('has no factory for 404, 503 or session_revoked (removed: nothing may throw them)', () => {
    // 404 under /auth lies to the pilgrim; the refresh route sends its own 401; 503
    // comes only from the error handler's default. A factory invites misuse.
    ['notFound', 'unavailable', 'sessionRevoked', 'invalidInput'].forEach((name) =>
      expect(ApiError[name]).toBeUndefined()
    );
  });

  test('ignores fieldErrors that are not an array', () => {
    expect(new ApiError(400, 'invalid_input', { field: 'x' }).fieldErrors).toEqual([]);
  });
});

describe('respond', () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  };

  test('sendJson writes a plain object with the status', () => {
    const res = mockRes();
    sendJson(res, 200, { tokens: {} });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ tokens: {} });
  });

  test.each([
    ['an array', []],
    ['null', null],
    ['a string', 'ok'],
    ['a class instance', new Date()],
    ['an envelope with success', { success: true }],
    ['an envelope with data', { data: {} }],
  ])('sendJson refuses %s', (_label, body) => {
    expect(() => sendJson(mockRes(), 200, body)).toThrow(TypeError);
  });

  test('sendNoContent sends 204 with no body', () => {
    const res = mockRes();
    sendNoContent(res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledWith();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('catchAsync', () => {
  test('forwards a rejected promise to next()', async () => {
    const error = new Error('boom');
    const next = jest.fn();
    await catchAsync(async () => {
      throw error;
    })({}, {}, next);
    expect(next).toHaveBeenCalledWith(error);
  });

  test('does not call next() when the handler resolves', async () => {
    const next = jest.fn();
    const handler = jest.fn().mockResolvedValue('ok');
    await catchAsync(handler)({}, {}, next);
    expect(handler).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('forwards a synchronous throw as well', async () => {
    const next = jest.fn();
    catchAsync(() => {
      throw new Error('sync boom');
    })({}, {}, next);
    await new Promise(process.nextTick);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

