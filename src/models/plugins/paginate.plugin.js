'use strict';

/**
 * Adds a `paginate` static to a schema.
 *
 * Deliberately implemented with `countDocuments` + `skip`/`limit` (rather than an
 * aggregation) so it works on every MongoDB deployment and stays index friendly.
 */
const paginate = (schema) => {
  /**
   * @param {object} [filter] Mongo filter object.
   * @param {object} [options]
   * @param {string} [options.sortBy] `field:(asc|desc)` pairs, comma separated.
   * @param {string} [options.populate] `path.nested` pairs, comma separated.
   * @param {number} [options.limit] Default 10, max 100.
   * @param {number} [options.page] Default 1.
   * @param {string} [options.select] Space separated projection.
   * @returns {Promise<{results: object[], page: number, limit: number, totalPages: number, totalResults: number}>}
   */
  // eslint-disable-next-line func-names
  schema.statics.paginate = async function (filter = {}, options = {}) {
    let sort = '';
    if (options.sortBy) {
      const sortingCriteria = [];
      options.sortBy.split(',').forEach((sortOption) => {
        const [key, order] = sortOption.split(':');
        if (key) {
          sortingCriteria.push((order === 'desc' ? '-' : '') + key.trim());
        }
      });
      sort = sortingCriteria.join(' ');
    } else {
      sort = '-createdAt';
    }

    const limit = Math.min(
      options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10,
      100
    );
    const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
    const skip = (page - 1) * limit;

    const countPromise = this.countDocuments(filter).exec();
    let docsPromise = this.find(filter).sort(sort).skip(skip).limit(limit);

    if (options.select) {
      docsPromise = docsPromise.select(options.select);
    }

    if (options.populate) {
      options.populate.split(',').forEach((populateOption) => {
        docsPromise = docsPromise.populate(
          populateOption
            .split('.')
            .reverse()
            .reduce((accumulator, path) => ({ path, populate: accumulator }))
        );
      });
    }

    const [totalResults, results] = await Promise.all([countPromise, docsPromise.exec()]);

    return {
      results,
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit) || 0,
      totalResults,
    };
  };
};

module.exports = paginate;
