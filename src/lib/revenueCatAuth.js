'use strict';

const crypto = require('crypto');

/** A signature older or newer than this is refused, so a captured request cannot be replayed. */
const TOLERANCE_SECONDS = 300;

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time string equality. Both sides are hashed first, so the comparison
 * takes the same time whatever the lengths are.
 */
const safeEqual = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(sha256(a), sha256(b));

/**
 * Parses `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. Returns null when the header is
 * missing or malformed.
 */
const parseSignatureHeader = (header) => {
  if (typeof header !== 'string') {
    return null;
  }
  let timestamp = null;
  const signatures = [];
  header.split(',').forEach((part) => {
    const index = part.indexOf('=');
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  });
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
};

/**
 * RevenueCat HMAC signing (BACKEND_SPEC.md §6b): HMAC-SHA256 over `${t}.${rawBody}`
 * with the integration's signing secret, hex encoded, and `t` within five minutes of
 * now. `rawBody` must be the request body bytes exactly as received.
 *
 * @param {{ rawBody: Buffer, header: string|undefined, secret: string, nowSeconds: number }} input
 * @returns {boolean}
 */
const verifySignature = ({ rawBody, header, secret, nowSeconds }) => {
  const parsed = parseSignatureHeader(header);
  if (!parsed || Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  // Every candidate is compared, so the time taken does not depend on which matched.
  return parsed.signatures
    .map((hex) => crypto.timingSafeEqual(expected, Buffer.from(hex, 'hex')))
    .includes(true);
};

/**
 * The fixed shared secret RevenueCat sends as the Authorization header, compared in
 * constant time. Used only when no signing secret is configured.
 */
const verifyAuthorization = ({ header, secret }) => safeEqual(header, secret);

module.exports = { verifySignature, verifyAuthorization, parseSignatureHeader, TOLERANCE_SECONDS };
