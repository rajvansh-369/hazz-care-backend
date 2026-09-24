'use strict';

/**
 * The only two ways a handler writes a response. Every body the client parses is
 * a bare JSON object at the root — no envelope, no array (BACKEND_SPEC.md §2, §7).
 */

const ENVELOPE_KEYS = ['success', 'data'];

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {object} obj A plain object; never an array, never wrapped in an envelope.
 */
const sendJson = (res, status, obj) => {
  if (!isPlainObject(obj)) {
    throw new TypeError('sendJson: body must be a plain JSON object');
  }
  const envelopeKey = ENVELOPE_KEYS.find((key) => Object.prototype.hasOwnProperty.call(obj, key));
  if (envelopeKey) {
    throw new TypeError(`sendJson: "${envelopeKey}" looks like a response envelope`);
  }
  return res.status(status).json(obj);
};

/** @param {import('express').Response} res */
const sendNoContent = (res) => res.status(204).end();

module.exports = { sendJson, sendNoContent, isPlainObject };
