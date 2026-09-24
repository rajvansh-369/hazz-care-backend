'use strict';

/**
 * The ONLY way a user or a session leaves the API (BACKEND_SPEC.md §3.1).
 *
 * The shapes are written out field by field rather than taken from the toJSON plugin,
 * so every type the client's parser checks is guaranteed here: `id` a non-empty
 * string, `fullName` a string or null, `emailVerified` a real boolean.
 */

/**
 * @param {{ _id: unknown, email: string, fullName?: string|null, emailVerified?: boolean }} userDoc
 * @returns {{ id: string, email: string, fullName: string|null, emailVerified: boolean }}
 */
const toAuthUser = (userDoc) => {
  const id = userDoc && userDoc._id != null ? String(userDoc._id) : '';
  if (!id.trim()) {
    // The client refuses a blank id, and it is the primary key of the pilgrim's
    // local database. Fail loudly (503) rather than send one.
    throw new Error('toAuthUser: user has no id');
  }
  return {
    id,
    email: userDoc.email,
    fullName: userDoc.fullName ?? null,
    emailVerified: userDoc.emailVerified === true,
  };
};

/**
 * @param {{ accessToken: string, refreshToken: string, expiresIn: number }} tokens
 * @param {object} userDoc
 */
const toAuthSession = (tokens, userDoc) => ({
  tokens: {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  },
  user: toAuthUser(userDoc),
});

module.exports = { toAuthUser, toAuthSession };
