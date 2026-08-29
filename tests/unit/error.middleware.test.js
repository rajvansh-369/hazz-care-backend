'use strict';

const mongoose = require('mongoose');
const {
  errorConverter,
  errorHandler,
  notFoundHandler,
} = require('../../src/middlewares/error.middleware');
const ApiError = require('../../src/utils/ApiError');
const httpStatus = require('../../src/utils/httpStatus');
const config = require('../../src/config/config');

const mockReq = (overrides = {}) => ({
  id: 'req-123',
  method: 'GET',
  originalUrl: '/api/v1/things',
  ...overrides,
});

const mockRes = () => {
  const res = { locals: {}, headersSent: false };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const convert = (error) => {
  const next = jest.fn();
  errorConverter(error, mockReq(), mockRes(), next);
  return next.mock.calls[0][0];
};

describe('notFoundHandler', () => {
  test('produces a 404 naming the route', () => {
    const next = jest.fn();
    notFoundHandler(mockReq({ method: 'POST', originalUrl: '/nope' }), mockRes(), next);
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('ROUTE_NOT_FOUND');
    expect(error.message).toContain('POST /nope');
  });
});

describe('errorConverter', () => {
  test('leaves an ApiError untouched', () => {
    const original = new ApiError(418, 'Teapot');
    expect(convert(original)).toBe(original);
  });

  test('converts a mongoose ValidationError into a 400 with details', () => {
    const schema = new mongoose.Schema({ name: { type: String, required: true } });
    const Model = mongoose.models.ConverterProbe || mongoose.model('ConverterProbe', schema);
    const validationError = new Model({}).validateSync();

    const converted = convert(validationError);
    expect(converted.statusCode).toBe(400);
    expect(converted.code).toBe('VALIDATION_ERROR');
    expect(converted.details[0]).toMatchObject({ field: 'name', location: 'body' });
  });

  test('converts a CastError into a 400', () => {
    const castError = new mongoose.Error.CastError('ObjectId', 'oops', 'taskId');
    const converted = convert(castError);
    expect(converted.statusCode).toBe(400);
    expect(converted.details[0].field).toBe('taskId');
  });

  test('converts a duplicate key error into a 409', () => {
    const duplicate = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: 'a@b.com' },
    });
    const converted = convert(duplicate);
    expect(converted.statusCode).toBe(409);
    expect(converted.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  test('converts a body parser failure into a 400', () => {
    const converted = convert(
      Object.assign(new SyntaxError('bad json'), { type: 'entity.parse.failed' })
    );
    expect(converted.statusCode).toBe(400);
    expect(converted.message).toBe('Request body is not valid JSON');
  });

  test('converts an oversized payload into a 413', () => {
    const converted = convert(Object.assign(new Error('too big'), { type: 'entity.too.large' }));
    expect(converted.statusCode).toBe(413);
    expect(converted.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('treats an unknown error as a non-operational 500', () => {
    const converted = convert(new Error('kaboom'));
    expect(converted.statusCode).toBe(500);
    expect(converted.isOperational).toBe(false);
  });
});

describe('errorHandler', () => {
  test('responds with the error envelope', () => {
    const res = mockRes();
    const error = new ApiError(400, 'Bad input', {
      code: 'VALIDATION_ERROR',
      details: [{ field: 'email', message: 'required' }],
    });

    errorHandler(error, mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Bad input',
      requestId: 'req-123',
    });
    expect(payload.details).toHaveLength(1);
  });

  test('exposes the stack outside production only', () => {
    const res = mockRes();
    errorHandler(new ApiError(500, 'oops'), mockReq(), res, jest.fn());
    expect(res.json.mock.calls[0][0].stack).toEqual(expect.any(String));
  });

  test('scrubs non-operational errors in production', () => {
    const res = mockRes();
    // `isProduction` is a resolved boolean on the config object, so it is
    // swapped for the duration of the assertion and restored afterwards.
    const original = config.isProduction;
    config.isProduction = true;
    try {
      errorHandler(ApiError.internal('Secret internal detail'), mockReq(), res, jest.fn());
      const payload = res.json.mock.calls[0][0];
      expect(payload.message).toBe('Internal server error');
      expect(payload.stack).toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(httpStatus.INTERNAL_SERVER_ERROR);
    } finally {
      config.isProduction = original;
    }
  });

  test('delegates to Express when headers were already sent', () => {
    const res = mockRes();
    res.headersSent = true;
    const next = jest.fn();
    const error = new ApiError(500, 'late');
    errorHandler(error, mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(res.json).not.toHaveBeenCalled();
  });

  test('records the message for the request logger', () => {
    const res = mockRes();
    errorHandler(new ApiError(404, 'Missing'), mockReq(), res, jest.fn());
    expect(res.locals.errorMessage).toBe('Missing');
  });
});
