'use strict';

const { User } = require('../models');
const { roleRights } = require('../config/roles');
const tokenTypes = require('../config/tokenTypes');
const tokenService = require('../services/token.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');
const catchAsync = require('../utils/catchAsync');

const extractBearerToken = (req) => {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length ? token : null;
};

const normaliseArgs = (args) => {
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return {
      rights: args[0].rights || [],
      allowSelf: !!args[0].allowSelf,
      selfParam: args[0].selfParam || 'userId',
    };
  }
  return { rights: args.filter(Boolean), allowSelf: false, selfParam: 'userId' };
};

/**
 * Authentication + authorization middleware.
 *
 * @example auth()                                        // any signed-in user
 * @example auth('users:read')                            // requires a right
 * @example auth({ rights: ['users:read'], allowSelf: true }) // right OR own record
 * @returns {import('express').RequestHandler}
 */
const auth = (...args) => {
  const { rights: requiredRights, allowSelf, selfParam } = normaliseArgs(args);

  return catchAsync(async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication token is missing', {
        code: errorCodes.UNAUTHENTICATED,
      });
    }

    const payload = tokenService.verifyJwt(token, tokenTypes.ACCESS);
    const user = await User.findById(payload.sub);

    if (!user) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Token is invalid', {
        code: errorCodes.TOKEN_INVALID,
      });
    }
    if (!user.isActive) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This account has been deactivated', {
        code: errorCodes.ACCOUNT_DISABLED,
      });
    }
    if (user.isLocked()) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This account is temporarily locked', {
        code: errorCodes.ACCOUNT_LOCKED,
      });
    }

    const userRights = roleRights.get(user.role) || [];
    req.user = user;
    req.principal = {
      id: user.id,
      role: user.role,
      rights: userRights,
      isAdmin: user.role === 'admin',
    };

    if (requiredRights.length) {
      const hasAllRights = requiredRights.every((right) => userRights.includes(right));
      // `selfParam` comes from the route definition, never from the request.
      // eslint-disable-next-line security/detect-object-injection
      const isSelf = allowSelf && req.params[selfParam] === user.id;
      if (!hasAllRights && !isSelf) {
        throw new ApiError(
          httpStatus.FORBIDDEN,
          'You do not have permission to perform this action',
          {
            code: errorCodes.FORBIDDEN,
          }
        );
      }
    }

    return next();
  });
};

module.exports = auth;
