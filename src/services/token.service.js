'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const config = require('../config/config');
const tokenTypes = require('../config/tokenTypes');
const { Token } = require('../models');
const ApiError = require('../utils/ApiError');
const errorCodes = require('../utils/errorCodes');

/** Tokens are stored hashed; a database dump therefore cannot be replayed. */
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60 * 1000);
const daysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/**
 * @param {string} userId
 * @param {Date} expires
 * @param {string} type
 * @param {object} [claims] Extra public claims (never secrets).
 * @returns {string}
 */
const generateToken = (userId, expires, type, claims = {}) => {
  const payload = {
    sub: String(userId),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expires.getTime() / 1000),
    type,
    jti: randomUUID(),
    ...claims,
  };
  return jwt.sign(payload, config.jwt.secret, {
    algorithm: 'HS256',
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
};

/**
 * Verifies signature, issuer, audience and expiry. Never touches the database.
 * @param {string} token
 * @param {string} expectedType
 * @returns {object} decoded payload
 */
const verifyJwt = (token, expectedType) => {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Token has expired', { code: errorCodes.TOKEN_EXPIRED });
    }
    throw new ApiError(401, 'Token is invalid', { code: errorCodes.TOKEN_INVALID });
  }
  if (payload.type !== expectedType) {
    throw new ApiError(401, 'Token is invalid', { code: errorCodes.TOKEN_INVALID });
  }
  return payload;
};

/**
 * @param {string} token
 * @param {string} userId
 * @param {Date} expires
 * @param {string} type
 * @param {object} [meta]
 * @returns {Promise<import('mongoose').Document>}
 */
const saveToken = async (token, userId, expires, type, meta = {}) => {
  return Token.create({
    token: hashToken(token),
    user: userId,
    expires,
    type,
    blacklisted: false,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
  });
};

/**
 * Verifies a stateful token (refresh / reset / verify email) against the store.
 * @param {string} token
 * @param {string} type
 * @returns {Promise<import('mongoose').Document>}
 */
const verifyStoredToken = async (token, type) => {
  const payload = verifyJwt(token, type);
  const tokenDoc = await Token.findOne({
    token: hashToken(token),
    type,
    user: payload.sub,
    blacklisted: false,
  });
  if (!tokenDoc) {
    throw new ApiError(401, 'Token is invalid or has already been used', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  if (tokenDoc.expires.getTime() <= Date.now()) {
    await Token.deleteOne({ _id: tokenDoc._id });
    throw new ApiError(401, 'Token has expired', { code: errorCodes.TOKEN_EXPIRED });
  }
  return tokenDoc;
};

/**
 * @param {object} user
 * @param {object} [meta] `{ ip, userAgent }`
 * @returns {Promise<{access: {token: string, expires: Date}, refresh: {token: string, expires: Date}}>}
 */
const generateAuthTokens = async (user, meta = {}) => {
  const accessTokenExpires = minutesFromNow(config.jwt.accessExpirationMinutes);
  const accessToken = generateToken(user.id, accessTokenExpires, tokenTypes.ACCESS, {
    role: user.role,
  });

  const refreshTokenExpires = daysFromNow(config.jwt.refreshExpirationDays);
  const refreshToken = generateToken(user.id, refreshTokenExpires, tokenTypes.REFRESH);
  await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH, meta);

  return {
    access: { token: accessToken, expires: accessTokenExpires },
    refresh: { token: refreshToken, expires: refreshTokenExpires },
  };
};

/**
 * @param {object} user
 * @returns {Promise<string>}
 */
const generateResetPasswordToken = async (user) => {
  const expires = minutesFromNow(config.jwt.resetPasswordExpirationMinutes);
  const token = generateToken(user.id, expires, tokenTypes.RESET_PASSWORD);
  await Token.deleteMany({ user: user.id, type: tokenTypes.RESET_PASSWORD });
  await saveToken(token, user.id, expires, tokenTypes.RESET_PASSWORD);
  return token;
};

/**
 * @param {object} user
 * @returns {Promise<string>}
 */
const generateVerifyEmailToken = async (user) => {
  const expires = minutesFromNow(config.jwt.verifyEmailExpirationMinutes);
  const token = generateToken(user.id, expires, tokenTypes.VERIFY_EMAIL);
  await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });
  await saveToken(token, user.id, expires, tokenTypes.VERIFY_EMAIL);
  return token;
};

/**
 * Removes every refresh token of a user. Used on logout-all and password change.
 * @param {string} userId
 * @returns {Promise<void>}
 */
const revokeAllUserTokens = async (userId, type = tokenTypes.REFRESH) => {
  await Token.deleteMany({ user: userId, type });
};

/** Housekeeping helper: drops tokens whose expiry has passed. */
const purgeExpiredTokens = async () => {
  const result = await Token.deleteMany({ expires: { $lt: new Date() } });
  return result.deletedCount || 0;
};

module.exports = {
  hashToken,
  generateToken,
  verifyJwt,
  saveToken,
  verifyStoredToken,
  generateAuthTokens,
  generateResetPasswordToken,
  generateVerifyEmailToken,
  revokeAllUserTokens,
  purgeExpiredTokens,
};
