'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../config/config');
const { Token, User } = require('../models');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REFRESH_PURGE_AFTER_MS = 7 * DAY_MS;
const RESET_PURGE_AFTER_MS = 24 * HOUR_MS;
const RESET_TOKEN_PREFIX = 'rst_';

/** Only this hash is stored; a database dump cannot be replayed as a token. */
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Thrown inside a rotation transaction to abort it and answer "dead token". Never
 * escapes rotate(): anything else that is thrown is an infrastructure problem and
 * propagates (the route turns it into a 503, which leaves the session alone).
 */
class DeadToken extends Error {}

/**
 * Tokens: access JWTs, opaque rotating refresh tokens, single-use reset tokens.
 *
 * `now` is injectable so tests move the clock instead of sleeping. Every time
 * decision in here (expiry, grace window, JWT iat/exp) reads it.
 *
 * @param {{ now?: () => Date }} [deps]
 */
const createTokenService = ({ now = () => new Date() } = {}) => {
  const accessTtlSeconds = config.jwt.accessTtlSeconds;
  const refreshTtlMs = config.tokens.refreshTtlDays * DAY_MS;
  const graceMs = config.tokens.refreshRotationGraceSeconds * 1000;
  const resetTtlMs = config.tokens.resetTtlSeconds * 1000;

  // ---------------------------------------------------------------- access tokens

  const signAccess = (userId, familyId) => {
    const iat = Math.floor(now().getTime() / 1000);
    return jwt.sign(
      {
        sub: String(userId),
        sid: familyId,
        jti: crypto.randomUUID(),
        iat,
        exp: iat + accessTtlSeconds,
      },
      config.jwt.accessSecret,
      { algorithm: 'HS256' }
    );
  };

  /**
   * @param {string} token
   * @returns {{ userId: string } | null}
   */
  const verifyAccess = (token) => {
    if (!isNonEmptyString(token)) {
      return null;
    }
    let payload;
    try {
      // algorithms is explicit: the token's own alg header is never trusted.
      payload = jwt.verify(token, config.jwt.accessSecret, {
        algorithms: ['HS256'],
        clockTimestamp: Math.floor(now().getTime() / 1000),
      });
    } catch (error) {
      return null;
    }
    if (!payload || typeof payload.sub !== 'string' || !payload.sub.trim()) {
      return null;
    }
    return { userId: payload.sub };
  };

  // --------------------------------------------------------------- refresh tokens

  /**
   * Issues an access token and a new refresh token. Only the refresh token's sha256
   * is stored.
   *
   * @param {string|import('mongoose').Types.ObjectId} userId
   * @param {{ session?: import('mongoose').ClientSession, familyId?: string }} [options]
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number, tokenId: import('mongoose').Types.ObjectId }>}
   */
  const issuePairWithId = async (userId, { session, familyId } = {}) => {
    const family = familyId || crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + refreshTtlMs);

    const [doc] = await Token.create(
      [
        {
          tokenHash: hashToken(refreshToken),
          user: userId,
          type: 'refresh',
          familyId: family,
          expiresAt,
          purgeAt: new Date(expiresAt.getTime() + REFRESH_PURGE_AFTER_MS),
        },
      ],
      { session }
    );

    return {
      accessToken: signAccess(userId, family),
      refreshToken,
      expiresIn: accessTtlSeconds,
      tokenId: doc._id,
    };
  };

  const issuePair = async (userId, options = {}) => {
    const { tokenId, ...pair } = await issuePairWithId(userId, options);
    return pair;
  };

  /**
   * The body of one rotation attempt. Runs inside a transaction; withTransaction may
   * run it more than once (for example after a write conflict with a concurrent
   * rotation of the same token), so it must not keep state between runs.
   */
  const rotateInSession = async (tokenHash, session) => {
    const at = now();

    const claimed = await Token.findOneAndUpdate(
      { tokenHash, type: 'refresh', revokedAt: null, expiresAt: { $gt: at } },
      { $set: { revokedAt: at, revokedReason: 'ROTATED', rotatedAt: at } },
      { session }
    );

    if (claimed) {
      if (!(await User.exists({ _id: claimed.user }).session(session))) {
        throw new DeadToken();
      }
      const { tokenId, ...pair } = await issuePairWithId(claimed.user, {
        session,
        familyId: claimed.familyId,
      });
      await Token.updateOne({ _id: claimed._id }, { $set: { replacedBy: tokenId } }, { session });
      return pair;
    }

    // Not claimable. The only survivable case is a token rotated moments ago: the
    // background refresher and the 401 interceptor race with the same old token.
    const existing = await Token.findOne({ tokenHash, type: 'refresh' }).session(session);
    if (
      !existing ||
      existing.revokedReason !== 'ROTATED' ||
      !existing.rotatedAt ||
      at.getTime() - existing.rotatedAt.getTime() > graceMs
    ) {
      // Unknown, expired, revoked for any other reason, or rotated too long ago.
      // Deliberately no family revocation: that would sign out the legitimate device.
      throw new DeadToken();
    }

    // A logout, password reset or admin revocation anywhere in the family ends the
    // grace window early: an old token must not resurrect a session ended on purpose.
    const familyEnded = await Token.exists({
      familyId: existing.familyId,
      type: 'refresh',
      revokedReason: { $in: ['LOGOUT', 'PASSWORD_RESET', 'ADMIN'] },
    }).session(session);
    if (familyEnded || !(await User.exists({ _id: existing.user }).session(session))) {
      throw new DeadToken();
    }

    // A fresh pair in the same family. The existing successor is NOT revoked: the
    // client keeps whichever response lands last, so every token handed out inside
    // the window has to stay valid.
    const { tokenId, ...pair } = await issuePairWithId(existing.user, {
      session,
      familyId: existing.familyId,
    });
    return pair;
  };

  /**
   * @param {string} rawToken
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number } | null>}
   *   null ONLY for a genuinely dead token. Infrastructure failures throw.
   */
  const rotate = async (rawToken) => {
    if (!isNonEmptyString(rawToken)) {
      return null;
    }
    const tokenHash = hashToken(rawToken);
    const session = await mongoose.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        // Overwritten on every run, so only the committed run's pair is returned.
        result = null;
        result = await rotateInSession(tokenHash, session);
      });
      return result;
    } catch (error) {
      if (error instanceof DeadToken) {
        return null;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  };

  /**
   * Unknown, empty or already-revoked tokens are a no-op.
   * @param {string} rawToken
   * @param {'LOGOUT'|'ROTATED'|'PASSWORD_RESET'|'ADMIN'} [reason]
   */
  const revoke = async (rawToken, reason = 'LOGOUT') => {
    if (!isNonEmptyString(rawToken)) {
      return;
    }
    await Token.updateOne(
      { tokenHash: hashToken(rawToken), type: 'refresh', revokedAt: null },
      { $set: { revokedAt: now(), revokedReason: reason } },
      { runValidators: true }
    );
  };

  /**
   * @param {string|import('mongoose').Types.ObjectId} userId
   * @param {'LOGOUT'|'PASSWORD_RESET'|'ADMIN'} reason
   * @param {{ session?: import('mongoose').ClientSession }} [options]
   */
  const revokeAllForUser = async (userId, reason, { session } = {}) => {
    await Token.updateMany(
      { user: userId, type: 'refresh', revokedAt: null },
      { $set: { revokedAt: now(), revokedReason: reason } },
      { session, runValidators: true }
    );
  };

  // ----------------------------------------------------------------- reset tokens

  /**
   * A short-lived, single-use token scoped to setting one account's password. It is
   * never a session and never a bearer token.
   * @returns {Promise<string>} the raw token, "rst_" + 32 random bytes (base64url)
   */
  const issueResetToken = async (userId, { session } = {}) => {
    const raw = RESET_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + resetTtlMs);
    await Token.create(
      [
        {
          tokenHash: hashToken(raw),
          user: userId,
          type: 'resetPassword',
          expiresAt,
          purgeAt: new Date(expiresAt.getTime() + RESET_PURGE_AFTER_MS),
          consumedAt: null,
        },
      ],
      { session }
    );
    return raw;
  };

  const usableResetFilter = (raw) => ({
    tokenHash: hashToken(raw),
    type: 'resetPassword',
    consumedAt: null,
    expiresAt: { $gt: now() },
  });

  /** Read only. */
  const findUsableResetToken = async (raw) => {
    if (!isNonEmptyString(raw)) {
      return null;
    }
    return Token.findOne(usableResetFilter(raw));
  };

  /** Atomic: of two concurrent calls, exactly one gets the document. */
  const consumeResetToken = async (raw, { session } = {}) => {
    if (!isNonEmptyString(raw)) {
      return null;
    }
    return Token.findOneAndUpdate(
      usableResetFilter(raw),
      { $set: { consumedAt: now() } },
      { session, new: true }
    );
  };

  const invalidateResetTokensForUser = async (userId, { session } = {}) => {
    await Token.updateMany(
      { user: userId, type: 'resetPassword', consumedAt: null },
      { $set: { consumedAt: now() } },
      { session }
    );
  };

  return {
    issuePair,
    rotate,
    revoke,
    revokeAllForUser,
    verifyAccess,
    issueResetToken,
    findUsableResetToken,
    consumeResetToken,
    invalidateResetTokensForUser,
  };
};

module.exports = {
  ...createTokenService(),
  createTokenService,
  hashToken,
};
