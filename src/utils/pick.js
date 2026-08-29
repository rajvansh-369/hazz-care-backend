'use strict';

/**
 * Creates an object composed of the picked object properties. Used to keep
 * unvalidated keys out of query and filter objects.
 *
 * Inherited and prototype keys are never copied: the `hasOwnProperty` guard is
 * what makes the indexed access below safe.
 *
 * @param {object} object
 * @param {string[]} keys
 * @returns {object}
 */
/* eslint-disable security/detect-object-injection */
const pick = (object, keys) =>
  keys.reduce((accumulator, key) => {
    if (object && Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined) {
      accumulator[key] = object[key];
    }
    return accumulator;
  }, {});
/* eslint-enable security/detect-object-injection */

module.exports = pick;
