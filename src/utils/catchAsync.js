'use strict';

/**
 * Wraps a route handler so that failures always reach Express' error pipeline
 * instead of becoming an unhandled rejection.
 *
 * Both rejection styles are covered: a rejected promise from an `async` handler
 * and a synchronous `throw` from a plain one.
 *
 * @param {Function} fn
 * @returns {import('express').RequestHandler}
 */
const catchAsync = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.then === 'function') {
      return result.catch(next);
    }
    return result;
  } catch (error) {
    return next(error);
  }
};

module.exports = catchAsync;
