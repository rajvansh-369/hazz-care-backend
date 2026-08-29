'use strict';

const config = require('../../src/config/config');
const tokenTypes = require('../../src/config/tokenTypes');
const tokenService = require('../../src/services/token.service');
const { userOne, userTwo, admin } = require('./user.fixture');

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

const accessTokenFor = (user) =>
  tokenService.generateToken(
    user._id,
    minutesFromNow(config.jwt.accessExpirationMinutes),
    tokenTypes.ACCESS,
    { role: user.role }
  );

const expiredAccessTokenFor = (user) =>
  tokenService.generateToken(user._id, minutesFromNow(-1), tokenTypes.ACCESS, { role: user.role });

module.exports = {
  accessTokenFor,
  expiredAccessTokenFor,
  get userOneAccessToken() {
    return accessTokenFor(userOne);
  },
  get userTwoAccessToken() {
    return accessTokenFor(userTwo);
  },
  get adminAccessToken() {
    return accessTokenFor(admin);
  },
};
