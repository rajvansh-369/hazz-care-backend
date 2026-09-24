'use strict';

const ApiError = require('../../src/utils/ApiError');
const catchAsync = require('../../src/utils/catchAsync');
const pick = require('../../src/utils/pick');
const httpStatus = require('../../src/utils/httpStatus');

describe('ApiError', () => {
  test('preserves a supplied stack when re-wrapping', () => {
    const error = new ApiError(500, 'Wrapped', { stack: 'original-stack' });
    expect(error.stack).toBe('original-stack');
  });

  test('internal() is flagged non-operational so it is scrubbed in production', () => {
    expect(ApiError.internal().isOperational).toBe(false);
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
