'use strict';

const ApiError = require('../../src/utils/ApiError');
const ApiResponse = require('../../src/utils/ApiResponse');
const catchAsync = require('../../src/utils/catchAsync');
const pick = require('../../src/utils/pick');
const httpStatus = require('../../src/utils/httpStatus');
const errorCodes = require('../../src/utils/errorCodes');

describe('ApiError', () => {
  test('defaults to an operational error with an internal code', () => {
    const error = new ApiError(httpStatus.BAD_REQUEST, 'Nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(400);
    expect(error.isOperational).toBe(true);
    expect(error.code).toBe(errorCodes.INTERNAL_ERROR);
    expect(error.details).toEqual([]);
    expect(error.stack).toEqual(expect.any(String));
  });

  test('carries a code and field level details', () => {
    const details = [{ field: 'email', message: 'is required' }];
    const error = new ApiError(400, 'Invalid', { code: errorCodes.VALIDATION_ERROR, details });
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual(details);
  });

  test('preserves a supplied stack when re-wrapping', () => {
    const error = new ApiError(500, 'Wrapped', { stack: 'original-stack' });
    expect(error.stack).toBe('original-stack');
  });

  test.each([
    ['badRequest', 400, errorCodes.VALIDATION_ERROR],
    ['unauthorized', 401, errorCodes.UNAUTHENTICATED],
    ['forbidden', 403, errorCodes.FORBIDDEN],
    ['notFound', 404, errorCodes.RESOURCE_NOT_FOUND],
    ['conflict', 409, errorCodes.DUPLICATE_RESOURCE],
  ])('%s() builds a %d', (factory, status, code) => {
    const error = ApiError[factory]();
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
    expect(error.isOperational).toBe(true);
  });

  test('internal() is flagged non-operational so it is scrubbed in production', () => {
    expect(ApiError.internal().isOperational).toBe(false);
  });
});

describe('ApiResponse', () => {
  const mockRes = () => {
    const res = { req: { id: 'req-1' } };
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  test('wraps data in the standard envelope', () => {
    const res = mockRes();
    ApiResponse.send(res, { data: { a: 1 }, message: 'Done' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Done',
      data: { a: 1 },
      requestId: 'req-1',
    });
  });

  test('includes meta only when supplied', () => {
    const res = mockRes();
    ApiResponse.send(res, { data: [], meta: { page: 1 } });
    expect(res.json.mock.calls[0][0].meta).toEqual({ page: 1 });
  });

  test('omits requestId when there is none', () => {
    const res = mockRes();
    res.req = undefined;
    ApiResponse.send(res, { data: null });
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('requestId');
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

describe('pick', () => {
  test('keeps only the requested keys', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  test('drops undefined values and missing keys', () => {
    expect(pick({ a: undefined, b: 2 }, ['a', 'b', 'z'])).toEqual({ b: 2 });
  });

  test('does not pick inherited properties', () => {
    const parent = { inherited: 'yes' };
    const child = Object.create(parent);
    child.own = 'mine';
    expect(pick(child, ['inherited', 'own'])).toEqual({ own: 'mine' });
  });

  test('tolerates a nullish source', () => {
    expect(pick(undefined, ['a'])).toEqual({});
  });
});

describe('httpStatus', () => {
  test('maps codes to messages', () => {
    expect(httpStatus.getStatusMessage(404)).toBe('Not Found');
    expect(httpStatus.getStatusMessage(599)).toBe('Unknown Status');
  });
});
