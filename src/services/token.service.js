'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../config/logger');
const { Token, User } = require('../models');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REFRESH_PURGE_AFTER_MS = 7 * DAY_MS;
const RESET_PURGE_AFTER_MS = 24 * HOUR_MS;
const RESET_TOKEN_PREFIX = 'rst_';
/**
 * Never-used children one refresh token may have alive at once. At the cap the oldest
 * is revoked to make room: refusing instead would strand a device whose refresh
 * responses keep getting lost (CLAUDE.md A10 rule l).
 */
const MAX_LIVE_CHILDREN = 10;

/** Only this hash is stored; a database dump cannot be replayed as a token. */
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Thrown inside a rotation transaction to abort it and answer "dead token". Never
 * escapes rotate(): anything else that is thrown is an infrastructure problem and
 * propagates (the route turns it into a 503, which leaves the session alone).
 *
 * `superseded` is the token when it died because its family moved on; rotate() logs it.
 */
class DeadToken extends Error {
  constructor(superseded = null) {
    super('dead refresh token');
    this.superseded = superseded;
  }
}

/**
 * Tokens: access JWTs, opaque refresh tokens rotated by use, single-use reset tokens.
 *
 * `now` is injectable so tests move the clock instead of sleeping. Every time
 * decision in here (expiry, JWT iat/exp) reads it.
 *
 * @param {{ now?: () => Date }} [deps]
 */
const createTokenService = ({ now = () => new Date() } = {}) => {
  const accessTtlSeconds = config.jwt.accessTtlSeconds;
  const refreshTtlMs = config.tokens.refreshTtlDays * DAY_MS;
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
  //
  // POST /auth/refresh with token X (CLAUDE.md A10 rule l). No time window anywhere:
  //   - X unknown, expired, revoked, or its user gone → dead (401).
  //   - X never used → mark it used and mint its first child.
  //   - X used, and none of its children used yet → mint another child, a sibling.
  //     This is how a device whose refresh response was lost survives, however long
  //     it takes to retry, and how two racing callers both get a 200.
  //   - one of X's children used → X was revoked as SUPERSEDED at that moment → dead,
  //     logged as 'reuse'. Nothing else is revoked (CLAUDE.md A4).
  // Using a token revokes every other live token in its family except its own
  // never-used siblings, which die at the family's next use: a response that landed
  // late may have put one of them on the device (the R1 race, CLAUDE.md A4).

  /**
   * Issues an access token and a new refresh token. Only the refresh token's sha256
   * is stored.
   *
   * @param {string|import('mongoose').Types.ObjectId} userId
   * @param {{ session?: import('mongoose').ClientSession, familyId?: string,
   *   parent?: import('mongoose').Types.ObjectId|null }} [options] no familyId = a new
   *   sign-in; `parent` is the token this one is minted from
   * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
   */
  const issuePair = async (userId, { session, familyId, parent = null } = {}) => {
    const family = familyId || crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + refreshTtlMs);

    await Token.create(
      [
        {
          tokenHash: hashToken(refreshToken),
          user: userId,
          type: 'refresh',
          familyId: family,
          parent,
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
    };
  };

  /** Mints a child of `token`: same user and family, a full TTL from now. */
  const mintChild = (token, session) =>
    issuePair(token.user, { session, familyId: token.familyId, parent: token._id });

  /**
   * X has never been used: mark it used, revoke the rest of the family except X's
   * never-used siblings, and mint X's first child.
   */
  const useFirstTime = async (token, at, session) => {
    // The precondition is in the filter. A concurrent rotation of X is a write
    // conflict, and withTransaction runs the whole attempt again.
    const claimed = await Token.findOneAndUpdate(
      { _id: token._id, revokedAt: null, rotatedAt: null },
      { $set: { rotatedAt: at }, $inc: { childCount: 1 } },
      { session, new: true }
    );
    if (!claimed) {
      // Cannot happen inside the transaction's snapshot. A 503, never a 401.
      throw new Error('refresh token changed during rotation');
    }

    await Token.updateMany(
      {
        familyId: claimed.familyId,
        user: claimed.user,
        type: 'refresh',
        revokedAt: null,
        _id: { $ne: claimed._id },
        $nor: [{ parent: claimed.parent || null, rotatedAt: null }],
      },
      { $set: { revokedAt: at, revokedReason: 'SUPERSEDED' } },
      { session }
    );

    return mintChild(claimed, session);
  };

  /**
   * X was used before and none of its children has been: mint another child. If X
   * already has MAX_LIVE_CHILDREN never-used children, the oldest is revoked first.
   *
   * @returns {Promise<{ pair: object, capped: object|null }>} `capped` is X when the
   *   cap was hit, for rotate() to log after the commit
   */
  const mintSibling = async (token, at, session) => {
    // Writing X serialises this with a concurrent first use of one of X's children,
    // which revokes X.
    const parent = await Token.findOneAndUpdate(
      { _id: token._id, revokedAt: null },
      { $inc: { childCount: 1 } },
      { session, new: true }
    );
    if (!parent) {
      throw new Error('refresh token changed during rotation');
    }

    const live = await Token.find({
      parent: parent._id,
      type: 'refresh',
      revokedAt: null,
      rotatedAt: null,
    })
      .sort({ createdAt: 1, _id: 1 })
      .select('_id')
      .session(session);

    let capped = null;
    if (live.length >= MAX_LIVE_CHILDREN) {
      const oldest = live.slice(0, live.length - MAX_LIVE_CHILDREN + 1).map((doc) => doc._id);
      await Token.updateMany(
        { _id: { $in: oldest }, revokedAt: null },
        { $set: { revokedAt: at, revokedReason: 'SUPERSEDED' } },
        { session }
      );
      capped = parent;
    }

    return { pair: await mintChild(parent, session), capped };
  };

  /**
   * The body of one rotation attempt. Runs inside a transaction; withTransaction may
   * run it more than once (for example after a write conflict with a concurrent
   * rotation in the same family), so it must not keep state between runs.
   */
  const rotateInSession = async (tokenHash, session) => {
    const at = now();

    const token = await Token.findOne({ tokenHash, type: 'refresh' }).session(session);
    if (!token || token.expiresAt <= at) {
      throw new DeadToken();
    }
    if (token.revokedAt) {
      throw new DeadToken(token.revokedReason === 'SUPERSEDED' ? token : null);
    }
    if (!(await User.exists({ _id: token.user }).session(session))) {
      throw new DeadToken();
    }

    if (!token.rotatedAt) {
      return { pair: await useFirstTime(token, at, session), capped: null };
    }
    return mintSibling(token, at, session);
  };

  /** Logged, never acted on: a family-wide revocation here could sign the pilgrim out. */
  const logSuperseded = (token) =>
    logger.warn('Refresh token presented after its family moved on; answered 401', {
      kind: token.rotatedAt ? 'reuse' : 'superseded',
      familyId: token.familyId,
      userId: String(token.user),
      tokenId: String(token._id),
    });

  const logCapped = (token) =>
    logger.warn('Refresh token hit its cap of never-used children; the oldest was revoked', {
      cap: MAX_LIVE_CHILDREN,
      familyId: token.familyId,
      userId: String(token.user),
      tokenId: String(token._id),
    });

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
    let result = null;
    try {
      await session.withTransaction(async () => {
        // Overwritten on every run, so only the committed run's result is kept.
        result = null;
        result = await rotateInSession(tokenHash, session);
      });
    } catch (error) {
      if (error instanceof DeadToken) {
        if (error.superseded) {
          logSuperseded(error.superseded);
        }
        return null;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (result.capped) {
      logCapped(result.capped);
    }
    return result.pair;
  };

  /**
   * Logout: revokes the presented token and every live token in its family, so no
   * sibling outlives it (CLAUDE.md A10 rule p). Any known refresh token counts — live,
   * used or already revoked. Unknown, empty or non-string tokens are a no-op.
   *
   * In a transaction: a rotation in the same family at the same moment writes a token
   * this also writes, so one of the two waits for the other. Either the rotation
   * commits first and its new token is revoked here, or it runs again and finds the
   * family revoked.
   *
   * @param {string} rawToken
   * @param {'LOGOUT'|'PASSWORD_RESET'|'ADMIN'} [reason]
   */
  const revokeFamily = async (rawToken, reason = 'LOGOUT') => {
    if (!isNonEmptyString(rawToken)) {
      return;
    }
    const tokenHash = hashToken(rawToken);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const token = await Token.findOne({ tokenHash, type: 'refresh' }).session(session);
        if (!token) {
          return;
        }
        await Token.updateMany(
          { familyId: token.familyId, user: token.user, type: 'refresh', revokedAt: null },
          { $set: { revokedAt: now(), revokedReason: reason } },
          { session, runValidators: true }
        );
      });
    } finally {
      await session.endSession();
    }
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
    revokeFamily,
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
  MAX_LIVE_CHILDREN,
};
