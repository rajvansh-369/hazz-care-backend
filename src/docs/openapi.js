'use strict';

const config = require('../config/config');
const { TASK_STATUSES, TASK_PRIORITIES } = require('../config/constants');
const { roles } = require('../config/roles');

const envelope = (dataSchema, description) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: dataSchema,
          requestId: { type: 'string', format: 'uuid' },
        },
      },
    },
  },
});

const errorResponse = (description, code) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: {
        success: false,
        code,
        message: description,
        requestId: '2f1b6f5e-2b1a-4d5f-8f7a-4a2b6c1d0e9f',
      },
    },
  },
});

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Node + MongoDB API Boilerplate',
    version: '1.0.0',
    description:
      'REST API with JWT authentication, role based access control, layered validation and a uniform response envelope. All successful responses share the shape `{ success, message, data, meta? }`; all failures share `{ success, code, message, details? , requestId }`.',
    license: { name: 'MIT' },
  },
  servers: [
    {
      url: `http://localhost:${config.gatewayPort}${config.apiPrefix}`,
      description: 'Via API gateway',
    },
    { url: `http://localhost:${config.port}${config.apiPrefix}`, description: 'Service direct' },
  ],
  tags: [
    { name: 'Health', description: 'Liveness and readiness probes' },
    { name: 'Auth', description: 'Registration, sessions and password management' },
    { name: 'Users', description: 'User administration and self-service profile' },
    { name: 'Tasks', description: 'Owned CRUD resource' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '652f1c8e4a1b2c0012a3b4c5' },
          name: { type: 'string', example: 'Ada Lovelace' },
          email: { type: 'string', format: 'email', example: 'ada@example.com' },
          role: { type: 'string', enum: roles, example: 'user' },
          isEmailVerified: { type: 'boolean', example: false },
          isActive: { type: 'boolean', example: true },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string', example: 'Wire up the payments webhook' },
          description: { type: 'string', example: 'Verify signatures before processing' },
          status: { type: 'string', enum: TASK_STATUSES, example: 'todo' },
          priority: { type: 'string', enum: TASK_PRIORITIES, example: 'high' },
          dueDate: { type: 'string', format: 'date-time', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          owner: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Tokens: {
        type: 'object',
        properties: {
          access: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              expires: { type: 'string', format: 'date-time' },
            },
          },
          refresh: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              expires: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                location: { type: 'string', enum: ['body', 'query', 'params'] },
                message: { type: 'string' },
              },
            },
          },
          requestId: { type: 'string' },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 10 },
          totalPages: { type: 'integer', example: 3 },
          totalResults: { type: 'integer', example: 27 },
        },
      },
    },
    parameters: {
      page: { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
      limit: {
        in: 'query',
        name: 'limit',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
      sortBy: {
        in: 'query',
        name: 'sortBy',
        description: 'field:(asc|desc), comma separated',
        schema: { type: 'string', example: 'createdAt:desc' },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        security: [],
        responses: { 200: envelope({ type: 'object' }, 'Service is live') },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe (checks MongoDB)',
        security: [],
        responses: {
          200: envelope({ type: 'object' }, 'Service is ready'),
          503: errorResponse('Service is not ready', 'SERVICE_UNAVAILABLE'),
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account and start a session',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string', example: 'Ada Lovelace' },
                  email: { type: 'string', format: 'email', example: 'ada@example.com' },
                  password: { type: 'string', example: 'Str0ng!Pass' },
                },
              },
            },
          },
        },
        responses: {
          201: envelope(
            { type: 'object', properties: { user: ref('User'), tokens: ref('Tokens') } },
            'Account created'
          ),
          400: errorResponse('Request validation failed', 'VALIDATION_ERROR'),
          409: errorResponse('Email is already registered', 'EMAIL_ALREADY_EXISTS'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a token pair',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: envelope(
            { type: 'object', properties: { user: ref('User'), tokens: ref('Tokens') } },
            'Signed in'
          ),
          401: errorResponse('Incorrect email or password', 'INVALID_CREDENTIALS'),
          403: errorResponse('Account locked or deactivated', 'ACCOUNT_LOCKED'),
        },
      },
    },
    '/auth/refresh-tokens': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token for a new pair',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: envelope(
            { type: 'object', properties: { tokens: ref('Tokens') } },
            'Session refreshed'
          ),
          401: errorResponse('Token is invalid or has already been used', 'TOKEN_INVALID'),
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'End the session tied to a refresh token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: envelope({ type: 'object', nullable: true }, 'Signed out'),
          404: errorResponse('Session not found or already ended', 'TOKEN_INVALID'),
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current principal, role and rights',
        responses: {
          200: envelope({ type: 'object', properties: { user: ref('User') } }, 'Current user'),
          401: errorResponse('Authentication token is missing', 'UNAUTHENTICATED'),
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Change password and revoke every session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: envelope({ type: 'object', nullable: true }, 'Password changed'),
          401: errorResponse('Current password is incorrect', 'INVALID_CREDENTIALS'),
        },
      },
    },
    '/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Read own profile',
        responses: {
          200: envelope({ type: 'object', properties: { user: ref('User') } }, 'Profile retrieved'),
        },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update own profile',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
        },
        responses: {
          200: envelope({ type: 'object', properties: { user: ref('User') } }, 'Profile updated'),
        },
      },
    },
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List users (requires users:read)',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/sortBy' },
        ],
        responses: {
          200: envelope({ type: 'array', items: ref('User') }, 'Users retrieved'),
          403: errorResponse('Insufficient rights', 'FORBIDDEN'),
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Create a user (requires users:write)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('User') } },
        },
        responses: {
          201: envelope({ type: 'object', properties: { user: ref('User') } }, 'User created'),
        },
      },
    },
    '/users/{userId}': {
      parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Users'],
        summary: 'Read a user (own record, or users:read)',
        responses: {
          200: envelope({ type: 'object', properties: { user: ref('User') } }, 'User retrieved'),
          404: errorResponse('User not found', 'RESOURCE_NOT_FOUND'),
        },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update a user (requires users:write)',
        requestBody: { required: true, content: { 'application/json': { schema: ref('User') } } },
        responses: {
          200: envelope({ type: 'object', properties: { user: ref('User') } }, 'User updated'),
        },
      },
      delete: {
        tags: ['Users'],
        summary: 'Delete a user (requires users:write)',
        responses: { 204: { description: 'User deleted' } },
      },
    },
    '/tasks': {
      get: {
        tags: ['Tasks'],
        summary: 'List own tasks (admins see every task)',
        parameters: [
          { $ref: '#/components/parameters/page' },
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/sortBy' },
          { in: 'query', name: 'status', schema: { type: 'string', enum: TASK_STATUSES } },
          { in: 'query', name: 'priority', schema: { type: 'string', enum: TASK_PRIORITIES } },
        ],
        responses: { 200: envelope({ type: 'array', items: ref('Task') }, 'Tasks retrieved') },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Create a task',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Task') } } },
        responses: {
          201: envelope({ type: 'object', properties: { task: ref('Task') } }, 'Task created'),
          400: errorResponse('Request validation failed', 'VALIDATION_ERROR'),
        },
      },
    },
    '/tasks/stats': {
      get: {
        tags: ['Tasks'],
        summary: 'Counts grouped by status',
        responses: { 200: envelope({ type: 'object' }, 'Task statistics') },
      },
    },
    '/tasks/{taskId}': {
      parameters: [{ in: 'path', name: 'taskId', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Tasks'],
        summary: 'Read a task',
        responses: {
          200: envelope({ type: 'object', properties: { task: ref('Task') } }, 'Task retrieved'),
          404: errorResponse('Task not found', 'RESOURCE_NOT_FOUND'),
        },
      },
      patch: {
        tags: ['Tasks'],
        summary: 'Update a task',
        requestBody: { required: true, content: { 'application/json': { schema: ref('Task') } } },
        responses: {
          200: envelope({ type: 'object', properties: { task: ref('Task') } }, 'Task updated'),
        },
      },
      delete: {
        tags: ['Tasks'],
        summary: 'Delete a task',
        responses: { 204: { description: 'Task deleted' } },
      },
    },
  },
};
