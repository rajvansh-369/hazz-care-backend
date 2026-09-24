'use strict';

const crypto = require('crypto');
const argon2 = require('argon2');

/**
 * Password hashing: argon2id only (CLAUDE.md A8).
 *
 * bcrypt silently truncates at 72 bytes, which BACKEND_SPEC.md §3.3 forbids, so it is
 * gone. The password is handed to argon2 exactly as received: no trimming, no Unicode
 * normalisation, no length cap. Length rules are validated at the edge (min 8 by JS
 * `.length`), never here.
 *
 * Parameters are the OWASP argon2id baseline: 19 MiB, 2 iterations, 1 lane.
 */
const HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

/**
 * @param {string} plain
 * @returns {Promise<string>} PHC string beginning `$argon2id$`
 */
const hash = async (plain) => argon2.hash(plain, HASH_OPTIONS);

/**
 * A wrong password resolves to `false`; it never throws. A malformed stored hash
 * does throw — that is corrupt data, not a failed sign-in, and must surface as an
 * unexpected error rather than as `invalid_credentials`.
 *
 * @param {string} storedHash
 * @param {string} plain
 * @returns {Promise<boolean>}
 */
const verify = async (storedHash, plain) => argon2.verify(storedHash, plain);

let dummyHashPromise = null;

/**
 * A hash of random bytes nobody knows, computed once on first use with the same
 * parameters as real hashes. Login verifies against it for an unknown email so that
 * path costs the same as a wrong password and timing does not reveal whether an
 * account exists (CLAUDE.md A6).
 *
 * @returns {Promise<string>}
 */
const getDummyHash = () => {
  if (!dummyHashPromise) {
    dummyHashPromise = hash(crypto.randomBytes(32).toString('hex')).catch((error) => {
      dummyHashPromise = null;
      throw error;
    });
  }
  return dummyHashPromise;
};

module.exports = {
  hash,
  verify,
  getDummyHash,
  HASH_OPTIONS,
};
