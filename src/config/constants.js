'use strict';

/** Domain enums shared by models, validations and the OpenAPI document. */
module.exports = {
  TASK_STATUSES: ['todo', 'in_progress', 'done'],
  TASK_PRIORITIES: ['low', 'medium', 'high'],
  REQUEST_ID_HEADER: 'x-request-id',
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 10,
};
