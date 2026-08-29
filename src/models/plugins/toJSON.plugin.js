'use strict';

/**
 * Normalises documents on serialisation:
 *  - `_id` becomes `id`
 *  - `__v`, and any path flagged `private: true`, are removed
 *  - Date paths are emitted as ISO strings
 */
const deleteAtPath = (object, path, index) => {
  if (index === path.length - 1) {
    // eslint-disable-next-line no-param-reassign, security/detect-object-injection
    delete object[path[index]];
    return;
  }
  // eslint-disable-next-line security/detect-object-injection
  const next = object[path[index]];
  if (next) {
    deleteAtPath(next, path, index + 1);
  }
};

const toJSON = (schema) => {
  let transform;
  if (schema.options.toJSON && schema.options.toJSON.transform) {
    transform = schema.options.toJSON.transform;
  }

  schema.options.toJSON = Object.assign(schema.options.toJSON || {}, {
    virtuals: true,
    transform(doc, ret, options) {
      Object.keys(schema.paths).forEach((path) => {
        // Keys are enumerated from the schema, so they cannot be attacker chosen.
        // eslint-disable-next-line security/detect-object-injection
        const pathOptions = schema.paths[path].options;
        if (pathOptions && pathOptions.private) {
          deleteAtPath(ret, path.split('.'), 0);
        }
      });

      ret.id = ret._id ? ret._id.toString() : ret.id;
      delete ret._id;
      delete ret.__v;

      if (ret.createdAt instanceof Date) {
        ret.createdAt = ret.createdAt.toISOString();
      }
      if (ret.updatedAt instanceof Date) {
        ret.updatedAt = ret.updatedAt.toISOString();
      }

      return transform ? transform(doc, ret, options) : ret;
    },
  });
};

module.exports = toJSON;
