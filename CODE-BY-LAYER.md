# Code by layer

Every file in `src/`, grouped by folder and ordered the way a request
actually travels through them: entry point, route, validation, middleware,
controller, service, model.

Each file is reproduced in full. Nothing here is abridged.

## Contents

- [Process entry](#process-entry) — 2 files
- [Routes](#routes) — 6 files
- [Validations](#validations) — 5 files
- [Middlewares](#middlewares) — 6 files
- [Controllers](#controllers) — 5 files
- [Services](#services) — 7 files
- [Models](#models) — 7 files
- [Utils](#utils) — 7 files
- [Config](#config) — 8 files
- [Gateway](#gateway) — 4 files
- [Scripts](#scripts) — 2 files
- [API documentation](#api-documentation) — 1 file

60 files, 3949 lines.

---

## Process entry

`app.js` builds the Express app and never listens. `index.js` owns the process: it connects to MongoDB, starts the server, and handles graceful shutdown. That split is what lets the integration tests drive the real app in-process without binding a port.

```
src/index.js
src/app.js
```

### `src/index.js`

<sub>74 lines</sub>

```javascript
'use strict';

const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const database = require('./config/database');

let server;

const shutdown = async (signal, exitCode = 0) => {
  logger.info(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed');
    }
    await database.disconnect();
    logger.info('MongoDB connection closed');
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error(`Error during shutdown: ${error.message}`);
    process.exit(1);
  }
};

const start = async () => {
  await database.connect();
  server = app.listen(config.port, () => {
    logger.info(`${config.serviceName} listening on port ${config.port} [${config.env}]`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} is already in use`);
    } else {
      logger.error(`HTTP server error: ${error.message}`);
    }
    process.exit(1);
  });

  return server;
};

// A crash must never leave the process in an undefined state: log, then exit so
// the orchestrator can replace the instance.
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.stack || error.message}`);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  shutdown('unhandledRejection', 1);
});

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => shutdown(signal, 0));
});

start().catch((error) => {
  logger.error(`Failed to start ${config.serviceName}: ${error.message}`);
  process.exit(1);
});

module.exports = { start, shutdown };
```

### `src/app.js`

<sub>108 lines</sub>

```javascript
'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

const config = require('./config/config');
const morgan = require('./config/morgan');
const routes = require('./routes/v1');
const requestId = require('./middlewares/requestId.middleware');
const { generalLimiter } = require('./middlewares/rateLimiter.middleware');
const { errorConverter, errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

const app = express();

// Honour X-Forwarded-* from exactly `trustProxy` hops (the gateway, by default).
// A fixed number rather than `true` keeps client IPs unspoofable.
app.set('trust proxy', config.trustProxy);
app.set('etag', 'strong');
app.disable('x-powered-by');

// 1. Correlation id first, so every later log line and error carries it.
app.use(requestId);

// 2. Request logging.
if (morgan.enabled) {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// 3. Security headers. `unsafe-inline` styles are allowed only because the
// bundled Swagger UI needs them; the API itself serves no HTML.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Helmet enables this by default; over plain http on a LAN address it
        // would upgrade the page's own assets to https and break them.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

// 4. CORS. `origin: true` reflects the caller's origin, which (unlike `*`) is
// compatible with credentialed requests from the Flutter web build.
const corsOptions = {
  origin:
    config.corsOrigins === '*'
      ? true
      : (origin, callback) => {
          if (!origin || config.corsOrigins.includes(origin)) {
            return callback(null, true);
          }
          return callback(new Error('Origin not allowed by CORS policy'));
        },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 600,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 5. Body parsing with a hard size ceiling.
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));
app.use(cookieParser());

// 6. Payload hygiene: strip Mongo operators, collapse duplicated query keys.
app.use(mongoSanitize({ replaceWith: '_' }));
app.use(hpp({ whitelist: ['sortBy', 'status', 'priority', 'tags'] }));

// 7. Response compression.
app.use(compression());

// Probes are exposed at the root as well, so orchestrators do not need to know
// the API prefix.
app.use('/health', require('./routes/v1/health.route'));

// 8. Versioned API behind the shared rate limiter.
app.use(config.apiPrefix, generalLimiter, routes);

// Optional static assets (the test console is normally served by the gateway).
app.use('/public', express.static(path.join(__dirname, '../public'), { maxAge: '1h' }));

// 9. Unmatched routes and the terminal error pipeline.
app.use(notFoundHandler);
app.use(errorConverter);
app.use(errorHandler);

module.exports = app;
```

---

## Routes

The URL map, and nothing else. Each route wires a path to its validation schema, its auth requirement, and one controller function. If you want to know what the API exposes, this folder is the whole answer.

Ordering matters here: `/me` is declared before `/:userId` and `/stats` before `/:taskId`, otherwise Express matches the parameter route first and treats the literal `stats` as an id.

```
src/routes/v1/auth.route.js
src/routes/v1/docs.route.js
src/routes/v1/health.route.js
src/routes/v1/index.js
src/routes/v1/task.route.js
src/routes/v1/user.route.js
```

### `src/routes/v1/auth.route.js`

<sub>42 lines</sub>

```javascript
'use strict';

const express = require('express');
const { authController } = require('../../controllers');
const { authValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');
const { authLimiter } = require('../../middlewares/rateLimiter.middleware');

const router = express.Router();

router.post('/register', authLimiter, validate(authValidation.register), authController.register);
router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.post(
  '/refresh-tokens',
  validate(authValidation.refreshTokens),
  authController.refreshTokens
);
router.post('/logout', validate(authValidation.logout), authController.logout);
router.post('/logout-all', auth(), authController.logoutAll);
router.post(
  '/forgot-password',
  authLimiter,
  validate(authValidation.forgotPassword),
  authController.forgotPassword
);
router.post(
  '/reset-password',
  authLimiter,
  validate(authValidation.resetPassword),
  authController.resetPassword
);
router.post('/verify-email', validate(authValidation.verifyEmail), authController.verifyEmail);
router.post(
  '/change-password',
  auth(),
  validate(authValidation.changePassword),
  authController.changePassword
);
router.get('/me', auth(), authController.me);

module.exports = router;
```

### `src/routes/v1/docs.route.js`

<sub>12 lines</sub>

```javascript
'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openApiDocument = require('../../docs/openapi');

const router = express.Router();

router.get('/openapi.json', (req, res) => res.json(openApiDocument));
router.use('/', swaggerUi.serve, swaggerUi.setup(openApiDocument, { explorer: false }));

module.exports = router;
```

### `src/routes/v1/health.route.js`

<sub>12 lines</sub>

```javascript
'use strict';

const express = require('express');
const { healthController } = require('../../controllers');

const router = express.Router();

router.get('/', healthController.live);
router.get('/live', healthController.live);
router.get('/ready', healthController.ready);

module.exports = router;
```

### `src/routes/v1/index.js`

<sub>29 lines</sub>

```javascript
'use strict';

const express = require('express');
const config = require('../../config/config');
const authRoute = require('./auth.route');
const userRoute = require('./user.route');
const taskRoute = require('./task.route');
const healthRoute = require('./health.route');
const docsRoute = require('./docs.route');

const router = express.Router();

const routes = [
  { path: '/health', route: healthRoute },
  { path: '/auth', route: authRoute },
  { path: '/users', route: userRoute },
  { path: '/tasks', route: taskRoute },
];

// API documentation is served everywhere except production, where it is opt-in.
const devOnlyRoutes = [{ path: '/docs', route: docsRoute }];

routes.forEach(({ path, route }) => router.use(path, route));

if (!config.isProduction) {
  devOnlyRoutes.forEach(({ path, route }) => router.use(path, route));
}

module.exports = router;
```

### `src/routes/v1/task.route.js`

<sub>28 lines</sub>

```javascript
'use strict';

const express = require('express');
const { taskController } = require('../../controllers');
const { taskValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');

const router = express.Router();

// Every task route requires an authenticated principal; ownership is enforced
// again in the service layer so a mistake in routing cannot leak data.
router.use(auth('tasks:manage-own'));

router.get('/stats', taskController.getTaskStats);

router
  .route('/')
  .post(validate(taskValidation.createTask), taskController.createTask)
  .get(validate(taskValidation.getTasks), taskController.getTasks);

router
  .route('/:taskId')
  .get(validate(taskValidation.getTask), taskController.getTask)
  .patch(validate(taskValidation.updateTask), taskController.updateTask)
  .delete(validate(taskValidation.deleteTask), taskController.deleteTask);

module.exports = router;
```

### `src/routes/v1/user.route.js`

<sub>33 lines</sub>

```javascript
'use strict';

const express = require('express');
const { userController } = require('../../controllers');
const { userValidation } = require('../../validations');
const validate = require('../../middlewares/validate.middleware');
const auth = require('../../middlewares/auth.middleware');

const router = express.Router();

// Self-service profile routes. Declared before `/:userId` so `me` is never
// interpreted as an id.
router
  .route('/me')
  .get(auth(), userController.getMe)
  .patch(auth(), validate(userValidation.updateMe), userController.updateMe);

router
  .route('/')
  .post(auth('users:write'), validate(userValidation.createUser), userController.createUser)
  .get(auth('users:read'), validate(userValidation.getUsers), userController.getUsers);

router
  .route('/:userId')
  .get(
    auth({ rights: ['users:read'], allowSelf: true }),
    validate(userValidation.getUser),
    userController.getUser
  )
  .patch(auth('users:write'), validate(userValidation.updateUser), userController.updateUser)
  .delete(auth('users:write'), validate(userValidation.deleteUser), userController.deleteUser);

module.exports = router;
```

---

## Validations

Joi schemas, one file per resource, split by request segment (`body`, `params`, `query`). Body and params reject unknown keys; query strips them instead, because proxies and browsers append their own parameters and a 400 there would be a bug report you can't reproduce.

```
src/validations/auth.validation.js
src/validations/custom.validation.js
src/validations/index.js
src/validations/task.validation.js
src/validations/user.validation.js
```

### `src/validations/auth.validation.js`

<sub>66 lines</sub>

```javascript
'use strict';

const Joi = require('joi');
const { password } = require('./custom.validation');

const email = Joi.string().trim().lowercase().email().max(254);

const register = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(2).max(80).required(),
    email: email.required(),
    password: Joi.string().max(128).custom(password).required(),
  }),
};

const login = {
  body: Joi.object().keys({
    email: email.required(),
    password: Joi.string().max(128).required(),
  }),
};

const refreshTokens = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required(),
  }),
};

const logout = refreshTokens;

const forgotPassword = {
  body: Joi.object().keys({
    email: email.required(),
  }),
};

const resetPassword = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    password: Joi.string().max(128).custom(password).required(),
  }),
};

const verifyEmail = {
  body: Joi.object().keys({
    token: Joi.string().required(),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    currentPassword: Joi.string().max(128).required(),
    newPassword: Joi.string().max(128).custom(password).required(),
  }),
};

module.exports = {
  register,
  login,
  logout,
  refreshTokens,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
};
```

### `src/validations/custom.validation.js`

<sub>36 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');

/** Joi custom rule: value must be a 24 character MongoDB ObjectId. */
const objectId = (value, helpers) => {
  if (
    !mongoose.Types.ObjectId.isValid(value) ||
    String(new mongoose.Types.ObjectId(value)) !== value
  ) {
    return helpers.message('{{#label}} must be a valid id');
  }
  return value;
};

/** Joi custom rule: strong password policy, mirrored in the User model. */
const password = (value, helpers) => {
  if (value.length < 8) {
    return helpers.message('{{#label}} must be at least 8 characters');
  }
  if (!/[a-z]/.test(value)) {
    return helpers.message('{{#label}} must contain a lowercase letter');
  }
  if (!/[A-Z]/.test(value)) {
    return helpers.message('{{#label}} must contain an uppercase letter');
  }
  if (!/\d/.test(value)) {
    return helpers.message('{{#label}} must contain a number');
  }
  if (!/[^A-Za-z\d]/.test(value)) {
    return helpers.message('{{#label}} must contain a special character');
  }
  return value;
};

module.exports = { objectId, password };
```

### `src/validations/index.js`

<sub>8 lines</sub>

```javascript
'use strict';

module.exports = {
  authValidation: require('./auth.validation'),
  taskValidation: require('./task.validation'),
  userValidation: require('./user.validation'),
  customValidation: require('./custom.validation'),
};
```

### `src/validations/task.validation.js`

<sub>49 lines</sub>

```javascript
'use strict';

const Joi = require('joi');
const { objectId } = require('./custom.validation');
const { TASK_STATUSES, TASK_PRIORITIES } = require('../config/constants');

const taskBody = {
  title: Joi.string().trim().min(3).max(120),
  description: Joi.string().trim().allow('').max(2000),
  status: Joi.string().valid(...TASK_STATUSES),
  priority: Joi.string().valid(...TASK_PRIORITIES),
  dueDate: Joi.date().iso().allow(null),
  tags: Joi.array().items(Joi.string().trim().min(1).max(24)).max(10),
};

const createTask = {
  body: Joi.object().keys({
    ...taskBody,
    title: taskBody.title.required(),
  }),
};

const getTasks = {
  query: Joi.object().keys({
    title: Joi.string().trim().max(120),
    status: Joi.string().valid(...TASK_STATUSES),
    priority: Joi.string().valid(...TASK_PRIORITIES),
    sortBy: Joi.string().max(60),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const getTask = {
  params: Joi.object().keys({
    taskId: Joi.string().custom(objectId).required(),
  }),
};

const updateTask = {
  params: Joi.object().keys({
    taskId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys(taskBody).min(1),
};

const deleteTask = getTask;

module.exports = { createTask, getTasks, getTask, updateTask, deleteTask };
```

### `src/validations/user.validation.js`

<sub>61 lines</sub>

```javascript
'use strict';

const Joi = require('joi');
const { objectId, password } = require('./custom.validation');
const { roles } = require('../config/roles');

const createUser = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(2).max(80).required(),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    password: Joi.string().max(128).custom(password).required(),
    role: Joi.string().valid(...roles),
    isActive: Joi.boolean(),
  }),
};

const getUsers = {
  query: Joi.object().keys({
    name: Joi.string().trim().max(80),
    email: Joi.string().trim().lowercase().max(254),
    role: Joi.string().valid(...roles),
    isActive: Joi.boolean(),
    sortBy: Joi.string().max(60),
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1),
  }),
};

const getUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
};

const updateUser = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(2).max(80),
      email: Joi.string().trim().lowercase().email().max(254),
      password: Joi.string().max(128).custom(password),
      role: Joi.string().valid(...roles),
      isActive: Joi.boolean(),
    })
    .min(1),
};

const updateMe = {
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(2).max(80),
      email: Joi.string().trim().lowercase().email().max(254),
    })
    .min(1),
};

const deleteUser = getUser;

module.exports = { createUser, getUsers, getUser, updateUser, updateMe, deleteUser };
```

---

## Middlewares

Everything that runs before a controller, plus the one thing that runs after everything: the error handler.

`requestId` assigns the correlation id. `auth` verifies the token and checks rights. `validate` runs the Joi schema. `rateLimiter` throttles. `error` converts anything thrown anywhere into the single failure envelope.

```
src/middlewares/auth.middleware.js
src/middlewares/error.middleware.js
src/middlewares/index.js
src/middlewares/rateLimiter.middleware.js
src/middlewares/requestId.middleware.js
src/middlewares/validate.middleware.js
```

### `src/middlewares/auth.middleware.js`

<sub>99 lines</sub>

```javascript
'use strict';

const { User } = require('../models');
const { roleRights } = require('../config/roles');
const tokenTypes = require('../config/tokenTypes');
const tokenService = require('../services/token.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');
const catchAsync = require('../utils/catchAsync');

const extractBearerToken = (req) => {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length ? token : null;
};

const normaliseArgs = (args) => {
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return {
      rights: args[0].rights || [],
      allowSelf: !!args[0].allowSelf,
      selfParam: args[0].selfParam || 'userId',
    };
  }
  return { rights: args.filter(Boolean), allowSelf: false, selfParam: 'userId' };
};

/**
 * Authentication + authorization middleware.
 *
 * @example auth()                                        // any signed-in user
 * @example auth('users:read')                            // requires a right
 * @example auth({ rights: ['users:read'], allowSelf: true }) // right OR own record
 * @returns {import('express').RequestHandler}
 */
const auth = (...args) => {
  const { rights: requiredRights, allowSelf, selfParam } = normaliseArgs(args);

  return catchAsync(async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication token is missing', {
        code: errorCodes.UNAUTHENTICATED,
      });
    }

    const payload = tokenService.verifyJwt(token, tokenTypes.ACCESS);
    const user = await User.findById(payload.sub);

    if (!user) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Token is invalid', {
        code: errorCodes.TOKEN_INVALID,
      });
    }
    if (!user.isActive) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This account has been deactivated', {
        code: errorCodes.ACCOUNT_DISABLED,
      });
    }
    if (user.isLocked()) {
      throw new ApiError(httpStatus.FORBIDDEN, 'This account is temporarily locked', {
        code: errorCodes.ACCOUNT_LOCKED,
      });
    }

    const userRights = roleRights.get(user.role) || [];
    req.user = user;
    req.principal = {
      id: user.id,
      role: user.role,
      rights: userRights,
      isAdmin: user.role === 'admin',
    };

    if (requiredRights.length) {
      const hasAllRights = requiredRights.every((right) => userRights.includes(right));
      // `selfParam` comes from the route definition, never from the request.
      // eslint-disable-next-line security/detect-object-injection
      const isSelf = allowSelf && req.params[selfParam] === user.id;
      if (!hasAllRights && !isSelf) {
        throw new ApiError(
          httpStatus.FORBIDDEN,
          'You do not have permission to perform this action',
          {
            code: errorCodes.FORBIDDEN,
          }
        );
      }
    }

    return next();
  });
};

module.exports = auth;
```

### `src/middlewares/error.middleware.js`

<sub>146 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

/** Terminal 404 for any request that matched no route. */
const notFoundHandler = (req, res, next) => {
  next(
    new ApiError(httpStatus.NOT_FOUND, `Route ${req.method} ${req.originalUrl} does not exist`, {
      code: errorCodes.ROUTE_NOT_FOUND,
    })
  );
};

const fromMongooseValidationError = (error) => {
  const details = Object.values(error.errors || {}).map((fieldError) => ({
    field: fieldError.path,
    location: 'body',
    message: fieldError.message,
  }));
  return new ApiError(httpStatus.BAD_REQUEST, 'Request validation failed', {
    code: errorCodes.VALIDATION_ERROR,
    details,
    stack: error.stack,
  });
};

const fromDuplicateKeyError = (error) => {
  const field = Object.keys(error.keyPattern || error.keyValue || { field: 1 })[0];
  return new ApiError(httpStatus.CONFLICT, `A record with this ${field} already exists`, {
    code: field === 'email' ? errorCodes.EMAIL_ALREADY_EXISTS : errorCodes.DUPLICATE_RESOURCE,
    details: [{ field, location: 'body', message: `This ${field} is already in use` }],
    stack: error.stack,
  });
};

/**
 * Normalises every thrown value into an ApiError before it reaches the handler.
 * Anything unrecognised becomes a non-operational 500, which the handler then
 * scrubs in production.
 */
// eslint-disable-next-line no-unused-vars
const errorConverter = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    if (error instanceof mongoose.Error.ValidationError) {
      error = fromMongooseValidationError(error);
    } else if (error instanceof mongoose.Error.CastError) {
      error = new ApiError(httpStatus.BAD_REQUEST, `Invalid value for '${error.path}'`, {
        code: errorCodes.VALIDATION_ERROR,
        details: [{ field: error.path, location: 'params', message: 'Malformed identifier' }],
        stack: error.stack,
      });
    } else if (error && (error.code === 11000 || error.code === 11001)) {
      error = fromDuplicateKeyError(error);
    } else if (error instanceof mongoose.Error) {
      error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database operation failed', {
        code: errorCodes.DATABASE_ERROR,
        isOperational: false,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.parse.failed') {
      error = new ApiError(httpStatus.BAD_REQUEST, 'Request body is not valid JSON', {
        code: errorCodes.VALIDATION_ERROR,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.too.large') {
      error = new ApiError(httpStatus.PAYLOAD_TOO_LARGE, 'Request body is too large', {
        code: errorCodes.PAYLOAD_TOO_LARGE,
        stack: error.stack,
      });
    } else if (error && error.type === 'charset.unsupported') {
      error = new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Unsupported charset', {
        code: errorCodes.UNSUPPORTED_MEDIA_TYPE,
        stack: error.stack,
      });
    } else {
      const statusCode =
        error && typeof error.statusCode === 'number'
          ? error.statusCode
          : httpStatus.INTERNAL_SERVER_ERROR;
      const message = (error && error.message) || httpStatus.getStatusMessage(statusCode);
      error = new ApiError(statusCode, message, {
        code: errorCodes.INTERNAL_ERROR,
        isOperational: false,
        stack: error && error.stack,
      });
    }
  }

  next(error);
};

/**
 * Single place where an error becomes an HTTP response. Non-operational errors
 * are scrubbed in production so internals are never leaked to a client.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  const { code, details, isOperational } = err;

  if (config.isProduction && !isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = 'Internal server error';
  }

  res.locals.errorMessage = err.message;

  const response = {
    success: false,
    code: code || errorCodes.INTERNAL_ERROR,
    message,
    ...(details && details.length ? { details } : {}),
    requestId: req.id,
    ...(config.isProduction ? {} : { stack: err.stack }),
  };

  const logPayload = {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code: response.code,
    userId: req.principal ? req.principal.id : undefined,
  };

  if (statusCode >= httpStatus.INTERNAL_SERVER_ERROR) {
    logger.error(`${message} :: ${err.stack || ''}`, logPayload);
  } else {
    logger.warn(message, logPayload);
  }

  if (res.headersSent) {
    return next(err);
  }

  return res.status(statusCode).json(response);
};

module.exports = { errorConverter, errorHandler, notFoundHandler };
```

### `src/middlewares/index.js`

<sub>9 lines</sub>

```javascript
'use strict';

module.exports = {
  auth: require('./auth.middleware'),
  requestId: require('./requestId.middleware'),
  validate: require('./validate.middleware'),
  ...require('./error.middleware'),
  ...require('./rateLimiter.middleware'),
};
```

### `src/middlewares/rateLimiter.middleware.js`

<sub>42 lines</sub>

```javascript
'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const buildLimiter = ({ windowMs, max, message, skipSuccessfulRequests = false }) =>
  rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Rate limiting is a transport concern; disable it entirely under test so
    // suites stay deterministic no matter how many requests they fire.
    skip: () => config.isTest,
    handler: (req, res, next) => {
      next(new ApiError(httpStatus.TOO_MANY_REQUESTS, message, { code: errorCodes.RATE_LIMITED }));
    },
  });

/** Broad limiter applied to the whole API surface. */
const generalLimiter = buildLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests. Please slow down and try again later.',
});

/**
 * Tight limiter for credential endpoints. Successful requests are not counted,
 * so a legitimate user is never locked out by their own activity.
 */
const authLimiter = buildLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
  message: 'Too many authentication attempts. Please try again later.',
});

module.exports = { generalLimiter, authLimiter, buildLimiter };
```

### `src/middlewares/requestId.middleware.js`

<sub>18 lines</sub>

```javascript
'use strict';

const { randomUUID } = require('crypto');
const { REQUEST_ID_HEADER } = require('../config/constants');

/**
 * Gives every request a stable id that is echoed back in the response headers,
 * logs and error payloads, so one identifier can be traced from the gateway
 * through the service to the log aggregator.
 */
const requestId = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
};

module.exports = requestId;
```

### `src/middlewares/validate.middleware.js`

<sub>78 lines</sub>

```javascript
'use strict';

const Joi = require('joi');
const pick = require('../utils/pick');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const SEGMENTS = ['params', 'query', 'body'];

/**
 * Request validation middleware.
 *
 * `params` and `body` reject unknown keys (so client typos surface immediately),
 * while `query` strips them (proxies and browsers routinely append their own).
 * The validated, coerced value replaces the raw input, so controllers only ever
 * see data that matched the schema.
 *
 * @param {object} schema `{ params?, query?, body? }` of Joi schemas.
 * @returns {import('express').RequestHandler}
 */
const validate = (schema) => (req, res, next) => {
  const validSchema = pick(schema, SEGMENTS);
  const details = [];

  Object.keys(validSchema).forEach((segment) => {
    // eslint-disable-next-line security/detect-object-injection
    const segmentSchema = Joi.compile(validSchema[segment]);
    const isQuery = segment === 'query';
    // eslint-disable-next-line security/detect-object-injection
    const { value, error } = segmentSchema
      .prefs({
        errors: { label: 'key', wrap: { label: false } },
        abortEarly: false,
        allowUnknown: isQuery,
        stripUnknown: isQuery,
        convert: true,
      })
      // eslint-disable-next-line security/detect-object-injection
      .validate(req[segment]);

    if (error) {
      error.details.forEach((detail) => {
        details.push({
          field: detail.path.join('.') || detail.context.key || segment,
          location: segment,
          message: detail.message,
        });
      });
      return;
    }

    // req.query has only a getter in some Express versions; mutate in place.
    if (isQuery) {
      Object.keys(req.query).forEach((key) => {
        // eslint-disable-next-line security/detect-object-injection
        delete req.query[key];
      });
      Object.assign(req.query, value);
    } else {
      // eslint-disable-next-line security/detect-object-injection
      req[segment] = value;
    }
  });

  if (details.length) {
    return next(
      new ApiError(httpStatus.BAD_REQUEST, 'Request validation failed', {
        code: errorCodes.VALIDATION_ERROR,
        details,
      })
    );
  }

  return next();
};

module.exports = validate;
```

---

## Controllers

Deliberately thin: read the request, call a service, shape a response. No business rules, no Mongoose queries, no `try`/`catch` — `catchAsync` handles rejections and synchronous throws alike.

Controllers pass `req.principal` (a plain `{ id, role, rights, isAdmin }` object) to services rather than the Mongoose user document, so services never depend on the HTTP layer.

```
src/controllers/auth.controller.js
src/controllers/health.controller.js
src/controllers/index.js
src/controllers/task.controller.js
src/controllers/user.controller.js
```

### `src/controllers/auth.controller.js`

<sub>127 lines</sub>

```javascript
'use strict';

const config = require('../config/config');
const { authService, tokenService, userService, emailService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

/** Client metadata attached to every issued session, useful for auditing. */
const clientMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') || null });

/**
 * Tokens returned to a client are only ever exposed in the JSON body; the refresh
 * token is additionally set as an httpOnly cookie for browser clients that want
 * one. Mobile clients (Flutter) simply ignore the cookie.
 */
const setRefreshCookie = (res, tokens) => {
  res.cookie('refreshToken', tokens.refresh.token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    expires: tokens.refresh.expires,
    path: '/',
  });
};

const register = catchAsync(async (req, res) => {
  const user = await authService.register(req.body);
  const tokens = await tokenService.generateAuthTokens(user, clientMeta(req));
  const verifyEmailToken = await tokenService.generateVerifyEmailToken(user);
  await emailService.sendVerificationEmail(user.email, verifyEmailToken);

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'Account created',
    data: {
      user,
      tokens,
      ...(config.isProduction ? {} : { verifyEmailToken }),
    },
  });
});

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const user = await authService.loginUserWithEmailAndPassword(email, password);
  const tokens = await tokenService.generateAuthTokens(user, clientMeta(req));

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, { message: 'Signed in', data: { user, tokens } });
});

const refreshTokens = catchAsync(async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
  const { user, tokens } = await authService.refreshAuth(refreshToken, clientMeta(req));

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, { message: 'Session refreshed', data: { user, tokens } });
});

const logout = catchAsync(async (req, res) => {
  await authService.logout(req.body.refreshToken || req.cookies.refreshToken);
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, { statusCode: httpStatus.OK, message: 'Signed out', data: null });
});

const logoutAll = catchAsync(async (req, res) => {
  await authService.logoutAll(req.principal.id);
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, { message: 'Signed out of every device', data: null });
});

const forgotPassword = catchAsync(async (req, res) => {
  const { token, user } = await authService.forgotPassword(req.body.email);
  if (token && user) {
    await emailService.sendResetPasswordEmail(user.email, token);
  }
  return ApiResponse.send(res, {
    message: 'If that email is registered, a reset link is on its way',
    data: config.isProduction ? null : { resetToken: token },
  });
});

const resetPassword = catchAsync(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  return ApiResponse.send(res, { message: 'Password updated, please sign in again', data: null });
});

const verifyEmail = catchAsync(async (req, res) => {
  const user = await authService.verifyEmail(req.body.token);
  return ApiResponse.send(res, { message: 'Email verified', data: { user } });
});

const changePassword = catchAsync(async (req, res) => {
  await authService.changePassword(
    req.principal.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, {
    message: 'Password changed, please sign in again',
    data: null,
  });
});

const me = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.principal.id);
  return ApiResponse.send(res, {
    message: 'Current user',
    data: { user, role: req.principal.role, rights: req.principal.rights },
  });
});

module.exports = {
  register,
  login,
  logout,
  logoutAll,
  refreshTokens,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  me,
};
```

### `src/controllers/health.controller.js`

<sub>20 lines</sub>

```javascript
'use strict';

const { healthService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const live = (req, res) =>
  ApiResponse.send(res, { message: 'Service is live', data: healthService.liveness() });

const ready = catchAsync(async (req, res) => {
  const report = await healthService.readiness();
  return ApiResponse.send(res, {
    statusCode: report.status === 'ready' ? httpStatus.OK : httpStatus.SERVICE_UNAVAILABLE,
    message: report.status === 'ready' ? 'Service is ready' : 'Service is not ready',
    data: report,
  });
});

module.exports = { live, ready };
```

### `src/controllers/index.js`

<sub>8 lines</sub>

```javascript
'use strict';

module.exports = {
  authController: require('./auth.controller'),
  healthController: require('./health.controller'),
  taskController: require('./task.controller'),
  userController: require('./user.controller'),
};
```

### `src/controllers/task.controller.js`

<sub>54 lines</sub>

```javascript
'use strict';

const { taskService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const pick = require('../utils/pick');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const createTask = catchAsync(async (req, res) => {
  const task = await taskService.createTask(req.body, req.principal);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'Task created',
    data: { task },
  });
});

const getTasks = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'status', 'priority']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await taskService.queryTasks(filter, options, req.principal);
  return ApiResponse.send(res, {
    message: 'Tasks retrieved',
    data: result.results,
    meta: {
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
    },
  });
});

const getTask = catchAsync(async (req, res) => {
  const task = await taskService.getTaskById(req.params.taskId, req.principal);
  return ApiResponse.send(res, { message: 'Task retrieved', data: { task } });
});

const updateTask = catchAsync(async (req, res) => {
  const task = await taskService.updateTaskById(req.params.taskId, req.body, req.principal);
  return ApiResponse.send(res, { message: 'Task updated', data: { task } });
});

const deleteTask = catchAsync(async (req, res) => {
  await taskService.deleteTaskById(req.params.taskId, req.principal);
  return res.status(httpStatus.NO_CONTENT).send();
});

const getTaskStats = catchAsync(async (req, res) => {
  const stats = await taskService.getTaskStats(req.principal);
  return ApiResponse.send(res, { message: 'Task statistics', data: stats });
});

module.exports = { createTask, getTasks, getTask, updateTask, deleteTask, getTaskStats };
```

### `src/controllers/user.controller.js`

<sub>59 lines</sub>

```javascript
'use strict';

const { userService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const pick = require('../utils/pick');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'User created',
    data: { user },
  });
});

const getUsers = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'email', 'role', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.queryUsers(filter, options);
  return ApiResponse.send(res, {
    message: 'Users retrieved',
    data: result.results,
    meta: {
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
    },
  });
});

const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.params.userId);
  return ApiResponse.send(res, { message: 'User retrieved', data: { user } });
});

const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.params.userId, req.body);
  return ApiResponse.send(res, { message: 'User updated', data: { user } });
});

const deleteUser = catchAsync(async (req, res) => {
  await userService.deleteUserById(req.params.userId);
  return res.status(httpStatus.NO_CONTENT).send();
});

const getMe = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.principal.id);
  return ApiResponse.send(res, { message: 'Profile retrieved', data: { user } });
});

const updateMe = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.principal.id, req.body);
  return ApiResponse.send(res, { message: 'Profile updated', data: { user } });
});

module.exports = { createUser, getUsers, getUser, updateUser, deleteUser, getMe, updateMe };
```

---

## Services

Where the actual rules live. Token rotation, brute-force lockout, ownership scoping, password revocation cascades — all here, all callable from a script or a queue worker without an HTTP request in sight.

Services throw `ApiError` with a status and a stable code. They never touch `req` or `res`.

```
src/services/auth.service.js
src/services/email.service.js
src/services/health.service.js
src/services/index.js
src/services/task.service.js
src/services/token.service.js
src/services/user.service.js
```

### `src/services/auth.service.js`

<sub>197 lines</sub>

```javascript
'use strict';

const { Token, User } = require('../models');
const config = require('../config/config');
const tokenTypes = require('../config/tokenTypes');
const userService = require('./user.service');
const tokenService = require('./token.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const INVALID_CREDENTIALS = () =>
  new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect email or password', {
    code: errorCodes.INVALID_CREDENTIALS,
  });

/**
 * Authenticates a user, applying brute force protection and account state checks.
 * The same generic message is returned for unknown emails and wrong passwords so
 * the endpoint cannot be used to enumerate accounts.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<User>}
 */
const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await userService.getUserByEmail(email, true);
  if (!user) {
    throw INVALID_CREDENTIALS();
  }

  if (!user.isActive) {
    throw new ApiError(httpStatus.FORBIDDEN, 'This account has been deactivated', {
      code: errorCodes.ACCOUNT_DISABLED,
    });
  }

  if (user.isLocked()) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Account locked after too many failed attempts. Try again in ${config.security.loginLockMinutes} minutes`,
      { code: errorCodes.ACCOUNT_LOCKED }
    );
  }

  const isMatch = await user.isPasswordMatch(password);
  if (!isMatch) {
    await user.registerFailedLogin();
    throw INVALID_CREDENTIALS();
  }

  await user.registerSuccessfulLogin();
  user.password = undefined;
  return user;
};

/**
 * @param {object} userBody
 * @returns {Promise<User>}
 */
const register = async (userBody) => userService.createUser(userBody);

/**
 * @param {string} refreshToken
 * @returns {Promise<void>}
 */
const logout = async (refreshToken) => {
  const tokenDoc = await Token.findOne({
    token: tokenService.hashToken(refreshToken),
    type: tokenTypes.REFRESH,
    blacklisted: false,
  });
  if (!tokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Session not found or already ended', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  await Token.deleteOne({ _id: tokenDoc._id });
};

/**
 * @param {string} userId
 * @returns {Promise<void>}
 */
const logoutAll = async (userId) => tokenService.revokeAllUserTokens(userId);

/**
 * Rotates a refresh token: the presented token is destroyed and a brand new pair
 * is issued, so a stolen refresh token is usable at most once.
 *
 * @param {string} refreshToken
 * @param {object} [meta]
 * @returns {Promise<{user: User, tokens: object}>}
 */
const refreshAuth = async (refreshToken, meta = {}) => {
  const refreshTokenDoc = await tokenService.verifyStoredToken(refreshToken, tokenTypes.REFRESH);
  const user = await userService.getUserById(refreshTokenDoc.user);
  if (!user || !user.isActive) {
    await Token.deleteOne({ _id: refreshTokenDoc._id });
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Session is no longer valid', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  await Token.deleteOne({ _id: refreshTokenDoc._id });
  const tokens = await tokenService.generateAuthTokens(user, meta);
  return { user, tokens };
};

/**
 * @param {string} email
 * @returns {Promise<{token: string|null, user: User|null}>}
 */
const forgotPassword = async (email) => {
  const user = await userService.getUserByEmail(email);
  if (!user || !user.isActive) {
    // Silently succeed so the endpoint cannot confirm which emails exist.
    return { token: null, user: null };
  }
  const token = await tokenService.generateResetPasswordToken(user);
  return { token, user };
};

/**
 * @param {string} resetPasswordToken
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const resetPassword = async (resetPasswordToken, newPassword) => {
  const tokenDoc = await tokenService.verifyStoredToken(
    resetPasswordToken,
    tokenTypes.RESET_PASSWORD
  );
  const user = await userService.getUserByIdOrFail(tokenDoc.user);

  user.password = newPassword;
  user.loginAttempts = 0;
  user.lockUntil = null;
  await user.save();

  await Token.deleteMany({ user: user.id, type: tokenTypes.RESET_PASSWORD });
  await tokenService.revokeAllUserTokens(user.id);
};

/**
 * @param {string} verifyEmailToken
 * @returns {Promise<User>}
 */
const verifyEmail = async (verifyEmailToken) => {
  const tokenDoc = await tokenService.verifyStoredToken(verifyEmailToken, tokenTypes.VERIFY_EMAIL);
  const user = await userService.getUserByIdOrFail(tokenDoc.user);
  user.isEmailVerified = true;
  await user.save();
  await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });
  return user;
};

/**
 * @param {string} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (!(await user.isPasswordMatch(currentPassword))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Current password is incorrect', {
      code: errorCodes.INVALID_CREDENTIALS,
      details: [{ field: 'currentPassword', message: 'Current password is incorrect' }],
    });
  }
  if (currentPassword === newPassword) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'New password must differ from the current one', {
      code: errorCodes.VALIDATION_ERROR,
      details: [{ field: 'newPassword', message: 'New password must differ from the current one' }],
    });
  }
  user.password = newPassword;
  await user.save();
  await tokenService.revokeAllUserTokens(user.id);
};

module.exports = {
  register,
  loginUserWithEmailAndPassword,
  logout,
  logoutAll,
  refreshAuth,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
};
```

### `src/services/email.service.js`

<sub>39 lines</sub>

```javascript
'use strict';

const logger = require('../config/logger');
const config = require('../config/config');

/**
 * Delivery adapter placeholder.
 *
 * The boilerplate ships without an SMTP dependency: every call is logged with the
 * payload a provider would need. Swap the body of `send` for nodemailer, SES,
 * Postmark or similar - the call sites and tests do not change.
 *
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{delivered: boolean, provider: string}>}
 */
const send = async ({ to, subject, text }) => {
  logger.info('Outbound email (no provider configured, logged only)', {
    to,
    subject,
    preview: config.isProduction ? '[redacted]' : text,
  });
  return { delivered: false, provider: 'noop' };
};

const sendResetPasswordEmail = async (to, token) =>
  send({
    to,
    subject: 'Reset your password',
    text: `Use this token to choose a new password within ${config.jwt.resetPasswordExpirationMinutes} minutes: ${token}`,
  });

const sendVerificationEmail = async (to, token) =>
  send({
    to,
    subject: 'Verify your email address',
    text: `Use this token to verify your email within ${config.jwt.verifyEmailExpirationMinutes} minutes: ${token}`,
  });

module.exports = { send, sendResetPasswordEmail, sendVerificationEmail };
```

### `src/services/health.service.js`

<sub>36 lines</sub>

```javascript
'use strict';

const os = require('os');
const config = require('../config/config');
const database = require('../config/database');

const startedAt = Date.now();

/** Liveness: the process is up and able to answer. */
const liveness = () => ({
  status: 'up',
  service: config.serviceName,
  env: config.env,
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  timestamp: new Date().toISOString(),
});

/** Readiness: every downstream dependency this service needs is usable. */
const readiness = async () => {
  const dependencies = {
    mongodb: database.isConnected() ? 'up' : 'down',
  };
  const healthy = Object.values(dependencies).every((state) => state === 'up');
  return {
    status: healthy ? 'ready' : 'not_ready',
    service: config.serviceName,
    dependencies,
    memory: {
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
      freeMemMb: Math.round((os.freemem() / 1024 / 1024) * 100) / 100,
    },
    timestamp: new Date().toISOString(),
  };
};

module.exports = { liveness, readiness };
```

### `src/services/index.js`

<sub>10 lines</sub>

```javascript
'use strict';

module.exports = {
  authService: require('./auth.service'),
  emailService: require('./email.service'),
  healthService: require('./health.service'),
  taskService: require('./task.service'),
  tokenService: require('./token.service'),
  userService: require('./user.service'),
};
```

### `src/services/task.service.js`

<sub>106 lines</sub>

```javascript
'use strict';

const { Task } = require('../models');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const canManageAnyTask = (user) =>
  Array.isArray(user.rights) && user.rights.includes('tasks:manage-any');

/**
 * @param {object} taskBody
 * @param {{id: string, role: string, rights: string[]}} principal Authenticated principal.
 * @returns {Promise<Task>}
 */
const createTask = async (taskBody, user) => Task.create({ ...taskBody, owner: user.id });

/**
 * Non-admins are always scoped to their own tasks, whatever filter they send.
 *
 * @param {object} filter
 * @param {object} options
 * @param {object} user
 * @returns {Promise<object>}
 */
const queryTasks = async (filter, options, user) => {
  const scopedFilter = { ...filter };
  if (!canManageAnyTask(user)) {
    scopedFilter.owner = user.id;
  }
  if (scopedFilter.title) {
    // Anchored, escaped prefix search keeps the query index friendly and safe.
    const escaped = String(scopedFilter.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scopedFilter.title = { $regex: `^${escaped}`, $options: 'i' };
  }
  return Task.paginate(scopedFilter, options);
};

/**
 * @param {string} taskId
 * @param {object} user
 * @returns {Promise<Task>}
 */
const getTaskById = async (taskId, user) => {
  const task = await Task.findById(taskId);
  if (!task) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (!canManageAnyTask(user) && String(task.owner) !== String(user.id)) {
    // 404 rather than 403: never confirm the existence of another user's record.
    throw new ApiError(httpStatus.NOT_FOUND, 'Task not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  return task;
};

/**
 * @param {string} taskId
 * @param {object} updateBody
 * @param {object} user
 * @returns {Promise<Task>}
 */
const updateTaskById = async (taskId, updateBody, user) => {
  const task = await getTaskById(taskId, user);
  Object.assign(task, updateBody);
  await task.save();
  return task;
};

/**
 * @param {string} taskId
 * @param {object} user
 * @returns {Promise<Task>}
 */
const deleteTaskById = async (taskId, user) => {
  const task = await getTaskById(taskId, user);
  await task.deleteOne();
  return task;
};

/**
 * @param {object} user
 * @returns {Promise<{total: number, todo: number, in_progress: number, done: number}>}
 */
const getTaskStats = async (user) => {
  const baseFilter = canManageAnyTask(user) ? {} : { owner: user.id };
  const [total, todo, inProgress, done] = await Promise.all([
    Task.countDocuments(baseFilter),
    Task.countDocuments({ ...baseFilter, status: 'todo' }),
    Task.countDocuments({ ...baseFilter, status: 'in_progress' }),
    Task.countDocuments({ ...baseFilter, status: 'done' }),
  ]);
  return { total, todo, in_progress: inProgress, done };
};

module.exports = {
  createTask,
  queryTasks,
  getTaskById,
  updateTaskById,
  deleteTaskById,
  getTaskStats,
};
```

### `src/services/token.service.js`

<sub>184 lines</sub>

```javascript
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const config = require('../config/config');
const tokenTypes = require('../config/tokenTypes');
const { Token } = require('../models');
const ApiError = require('../utils/ApiError');
const errorCodes = require('../utils/errorCodes');

/** Tokens are stored hashed; a database dump therefore cannot be replayed. */
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60 * 1000);
const daysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/**
 * @param {string} userId
 * @param {Date} expires
 * @param {string} type
 * @param {object} [claims] Extra public claims (never secrets).
 * @returns {string}
 */
const generateToken = (userId, expires, type, claims = {}) => {
  const payload = {
    sub: String(userId),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expires.getTime() / 1000),
    type,
    jti: randomUUID(),
    ...claims,
  };
  return jwt.sign(payload, config.jwt.secret, {
    algorithm: 'HS256',
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
};

/**
 * Verifies signature, issuer, audience and expiry. Never touches the database.
 * @param {string} token
 * @param {string} expectedType
 * @returns {object} decoded payload
 */
const verifyJwt = (token, expectedType) => {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Token has expired', { code: errorCodes.TOKEN_EXPIRED });
    }
    throw new ApiError(401, 'Token is invalid', { code: errorCodes.TOKEN_INVALID });
  }
  if (payload.type !== expectedType) {
    throw new ApiError(401, 'Token is invalid', { code: errorCodes.TOKEN_INVALID });
  }
  return payload;
};

/**
 * @param {string} token
 * @param {string} userId
 * @param {Date} expires
 * @param {string} type
 * @param {object} [meta]
 * @returns {Promise<import('mongoose').Document>}
 */
const saveToken = async (token, userId, expires, type, meta = {}) => {
  return Token.create({
    token: hashToken(token),
    user: userId,
    expires,
    type,
    blacklisted: false,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
  });
};

/**
 * Verifies a stateful token (refresh / reset / verify email) against the store.
 * @param {string} token
 * @param {string} type
 * @returns {Promise<import('mongoose').Document>}
 */
const verifyStoredToken = async (token, type) => {
  const payload = verifyJwt(token, type);
  const tokenDoc = await Token.findOne({
    token: hashToken(token),
    type,
    user: payload.sub,
    blacklisted: false,
  });
  if (!tokenDoc) {
    throw new ApiError(401, 'Token is invalid or has already been used', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  if (tokenDoc.expires.getTime() <= Date.now()) {
    await Token.deleteOne({ _id: tokenDoc._id });
    throw new ApiError(401, 'Token has expired', { code: errorCodes.TOKEN_EXPIRED });
  }
  return tokenDoc;
};

/**
 * @param {object} user
 * @param {object} [meta] `{ ip, userAgent }`
 * @returns {Promise<{access: {token: string, expires: Date}, refresh: {token: string, expires: Date}}>}
 */
const generateAuthTokens = async (user, meta = {}) => {
  const accessTokenExpires = minutesFromNow(config.jwt.accessExpirationMinutes);
  const accessToken = generateToken(user.id, accessTokenExpires, tokenTypes.ACCESS, {
    role: user.role,
  });

  const refreshTokenExpires = daysFromNow(config.jwt.refreshExpirationDays);
  const refreshToken = generateToken(user.id, refreshTokenExpires, tokenTypes.REFRESH);
  await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH, meta);

  return {
    access: { token: accessToken, expires: accessTokenExpires },
    refresh: { token: refreshToken, expires: refreshTokenExpires },
  };
};

/**
 * @param {object} user
 * @returns {Promise<string>}
 */
const generateResetPasswordToken = async (user) => {
  const expires = minutesFromNow(config.jwt.resetPasswordExpirationMinutes);
  const token = generateToken(user.id, expires, tokenTypes.RESET_PASSWORD);
  await Token.deleteMany({ user: user.id, type: tokenTypes.RESET_PASSWORD });
  await saveToken(token, user.id, expires, tokenTypes.RESET_PASSWORD);
  return token;
};

/**
 * @param {object} user
 * @returns {Promise<string>}
 */
const generateVerifyEmailToken = async (user) => {
  const expires = minutesFromNow(config.jwt.verifyEmailExpirationMinutes);
  const token = generateToken(user.id, expires, tokenTypes.VERIFY_EMAIL);
  await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });
  await saveToken(token, user.id, expires, tokenTypes.VERIFY_EMAIL);
  return token;
};

/**
 * Removes every refresh token of a user. Used on logout-all and password change.
 * @param {string} userId
 * @returns {Promise<void>}
 */
const revokeAllUserTokens = async (userId, type = tokenTypes.REFRESH) => {
  await Token.deleteMany({ user: userId, type });
};

/** Housekeeping helper: drops tokens whose expiry has passed. */
const purgeExpiredTokens = async () => {
  const result = await Token.deleteMany({ expires: { $lt: new Date() } });
  return result.deletedCount || 0;
};

module.exports = {
  hashToken,
  generateToken,
  verifyJwt,
  saveToken,
  verifyStoredToken,
  generateAuthTokens,
  generateResetPasswordToken,
  generateVerifyEmailToken,
  revokeAllUserTokens,
  purgeExpiredTokens,
};
```

### `src/services/user.service.js`

<sub>95 lines</sub>

```javascript
'use strict';

const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

/**
 * @param {object} userBody
 * @returns {Promise<User>}
 */
const createUser = async (userBody) => {
  if (await User.isEmailTaken(userBody.email)) {
    throw new ApiError(httpStatus.CONFLICT, 'Email is already registered', {
      code: errorCodes.EMAIL_ALREADY_EXISTS,
      details: [{ field: 'email', message: 'Email is already registered' }],
    });
  }
  return User.create(userBody);
};

/**
 * @param {object} filter
 * @param {object} options
 * @returns {Promise<object>}
 */
const queryUsers = async (filter, options) => User.paginate(filter, options);

/**
 * @param {string} id
 * @returns {Promise<User|null>}
 */
const getUserById = async (id) => User.findById(id);

/**
 * @param {string} email
 * @param {boolean} [withPassword]
 * @returns {Promise<User|null>}
 */
const getUserByEmail = async (email, withPassword = false) => {
  const query = User.findOne({ email: String(email).toLowerCase() });
  return withPassword ? query.select('+password') : query;
};

/**
 * @param {string} userId
 * @returns {Promise<User>}
 */
const getUserByIdOrFail = async (userId) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  return user;
};

/**
 * @param {string} userId
 * @param {object} updateBody
 * @returns {Promise<User>}
 */
const updateUserById = async (userId, updateBody) => {
  const user = await getUserByIdOrFail(userId);
  if (updateBody.email && (await User.isEmailTaken(updateBody.email, userId))) {
    throw new ApiError(httpStatus.CONFLICT, 'Email is already registered', {
      code: errorCodes.EMAIL_ALREADY_EXISTS,
      details: [{ field: 'email', message: 'Email is already registered' }],
    });
  }
  Object.assign(user, updateBody);
  await user.save();
  return user;
};

/**
 * @param {string} userId
 * @returns {Promise<User>}
 */
const deleteUserById = async (userId) => {
  const user = await getUserByIdOrFail(userId);
  await user.deleteOne();
  return user;
};

module.exports = {
  createUser,
  queryUsers,
  getUserById,
  getUserByIdOrFail,
  getUserByEmail,
  updateUserById,
  deleteUserById,
};
```

---

## Models

Mongoose schemas plus two shared plugins. `toJSON` strips `_id`, `__v` and anything marked `private` (password hashes never leave this layer). `paginate` adds a consistent `page`/`limit`/`sortBy` query to every model.

```
src/models/index.js
src/models/plugins/index.js
src/models/plugins/paginate.plugin.js
src/models/plugins/toJSON.plugin.js
src/models/task.model.js
src/models/token.model.js
src/models/user.model.js
```

### `src/models/index.js`

<sub>7 lines</sub>

```javascript
'use strict';

module.exports = {
  User: require('./user.model'),
  Token: require('./token.model'),
  Task: require('./task.model'),
};
```

### `src/models/plugins/index.js`

<sub>6 lines</sub>

```javascript
'use strict';

module.exports = {
  toJSON: require('./toJSON.plugin'),
  paginate: require('./paginate.plugin'),
};
```

### `src/models/plugins/paginate.plugin.js`

<sub>73 lines</sub>

```javascript
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
```

### `src/models/plugins/toJSON.plugin.js`

<sub>56 lines</sub>

```javascript
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
```

### `src/models/task.model.js`

<sub>71 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');
const { TASK_STATUSES, TASK_PRIORITIES } = require('../config/constants');

/** Sample business resource used to demonstrate owned, paginated CRUD. */
const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [120, 'Title must be at most 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description must be at most 2000 characters'],
      default: '',
    },
    status: {
      type: String,
      enum: { values: TASK_STATUSES, message: 'Status must be one of: {VALUES}' },
      default: 'todo',
    },
    priority: {
      type: String,
      enum: { values: TASK_PRIORITIES, message: 'Priority must be one of: {VALUES}' },
      default: 'medium',
    },
    dueDate: {
      type: Date,
      default: null,
    },
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (tags) => tags.length <= 10,
        message: 'A task can have at most 10 tags',
      },
    },
    completedAt: {
      type: Date,
      default: null,
    },
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

taskSchema.plugin(toJSON);
taskSchema.plugin(paginate);

taskSchema.pre('save', function stampCompletion(next) {
  if (this.isModified('status')) {
    this.completedAt = this.status === 'done' ? new Date() : null;
  }
  next();
});

const Task = mongoose.model('Task', taskSchema);

module.exports = Task;
```

### `src/models/token.model.js`

<sub>48 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');
const { tokenTypes } = require('../config');
const { toJSON } = require('./plugins');

/**
 * Refresh / reset / verification tokens are persisted as SHA-256 hashes so a
 * database leak cannot be replayed against the API.
 */
const tokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      index: true,
      private: true,
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(tokenTypes),
      required: true,
    },
    expires: {
      type: Date,
      required: true,
    },
    blacklisted: {
      type: Boolean,
      default: false,
    },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true }
);

tokenSchema.plugin(toJSON);

const Token = mongoose.model('Token', tokenSchema);

module.exports = Token;
```

### `src/models/user.model.js`

<sub>150 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config/config');
const { roles } = require('../config/roles');
const { toJSON, paginate } = require('./plugins');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [80, 'Name must be at most 80 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email must be at most 254 characters'],
      validate: {
        validator: (value) => EMAIL_REGEX.test(value),
        message: 'Email must be a valid email address',
      },
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      validate: {
        // Only validated when the raw value is set; hashed values skip this check.
        validator(value) {
          return this.isModified('password') ? PASSWORD_REGEX.test(value) : true;
        },
        message:
          'Password must contain an uppercase letter, a lowercase letter, a number and a special character',
      },
      private: true,
    },
    role: {
      type: String,
      enum: {
        values: roles,
        message: 'Role must be one of: {VALUES}',
      },
      default: 'user',
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    loginAttempts: {
      type: Number,
      default: 0,
      private: true,
    },
    lockUntil: {
      type: Date,
      default: null,
      private: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: '__v',
  }
);

userSchema.plugin(toJSON);
userSchema.plugin(paginate);

userSchema.index({ role: 1 });

/**
 * @param {string} email
 * @param {mongoose.ObjectId} [excludeUserId]
 * @returns {Promise<boolean>}
 */
userSchema.statics.isEmailTaken = async function isEmailTaken(email, excludeUserId) {
  const user = await this.findOne({ email: String(email).toLowerCase() }).select('_id');
  if (!user) {
    return false;
  }
  return String(user._id) !== String(excludeUserId || '');
};

/**
 * @param {string} candidatePassword
 * @returns {Promise<boolean>}
 */
userSchema.methods.isPasswordMatch = async function isPasswordMatch(candidatePassword) {
  if (!this.password) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isLocked = function isLocked() {
  return !!(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

/** Brute force protection: lock the account after N consecutive failures. */
userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const update = { $inc: { loginAttempts: 1 } };
  const attempts = (this.loginAttempts || 0) + 1;
  if (attempts >= config.security.loginMaxAttempts) {
    update.$set = {
      lockUntil: new Date(Date.now() + config.security.loginLockMinutes * 60 * 1000),
    };
  }
  await this.constructor.updateOne({ _id: this._id }, update);
};

userSchema.methods.registerSuccessfulLogin = async function registerSuccessfulLogin() {
  await this.constructor.updateOne(
    { _id: this._id },
    { $set: { loginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } }
  );
};

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }
  try {
    this.password = await bcrypt.hash(this.password, config.security.bcryptSaltRounds);
    return next();
  } catch (error) {
    return next(error);
  }
});

const User = mongoose.model('User', userSchema);

module.exports = User;
```

---

## Utils

Small, dependency-free helpers. `ApiError` and `ApiResponse` define the two envelopes; `errorCodes` is the list of stable strings clients branch on; `catchAsync` wraps controllers; `pick` keeps unvalidated keys out of filter objects.

```
src/utils/ApiError.js
src/utils/ApiResponse.js
src/utils/catchAsync.js
src/utils/errorCodes.js
src/utils/httpStatus.js
src/utils/index.js
src/utils/pick.js
```

### `src/utils/ApiError.js`

<sub>84 lines</sub>

```javascript
'use strict';

const httpStatus = require('./httpStatus');
const errorCodes = require('./errorCodes');

/**
 * The single error type the application throws. Anything that reaches the error
 * handler as a plain Error is treated as a non-operational bug and reported as a
 * 500 without leaking internals.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode HTTP status to return.
   * @param {string} message Human readable message, safe to show to a client.
   * @param {object} [options]
   * @param {string} [options.code] Stable machine readable error code.
   * @param {Array<{field: string, message: string}>} [options.details] Field level details.
   * @param {boolean} [options.isOperational] False for programmer errors.
   * @param {string} [options.stack] Preserve an original stack when re-wrapping.
   */
  constructor(statusCode, message, options = {}) {
    super(message);
    const {
      code = errorCodes.INTERNAL_ERROR,
      details = [],
      isOperational = true,
      stack = '',
    } = options;

    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  static badRequest(message = 'Bad request', options = {}) {
    return new ApiError(httpStatus.BAD_REQUEST, message, {
      code: errorCodes.VALIDATION_ERROR,
      ...options,
    });
  }

  static unauthorized(message = 'Authentication required', options = {}) {
    return new ApiError(httpStatus.UNAUTHORIZED, message, {
      code: errorCodes.UNAUTHENTICATED,
      ...options,
    });
  }

  static forbidden(message = 'You do not have permission to perform this action', options = {}) {
    return new ApiError(httpStatus.FORBIDDEN, message, { code: errorCodes.FORBIDDEN, ...options });
  }

  static notFound(message = 'Resource not found', options = {}) {
    return new ApiError(httpStatus.NOT_FOUND, message, {
      code: errorCodes.RESOURCE_NOT_FOUND,
      ...options,
    });
  }

  static conflict(message = 'Resource already exists', options = {}) {
    return new ApiError(httpStatus.CONFLICT, message, {
      code: errorCodes.DUPLICATE_RESOURCE,
      ...options,
    });
  }

  static internal(message = 'Something went wrong', options = {}) {
    return new ApiError(httpStatus.INTERNAL_SERVER_ERROR, message, {
      code: errorCodes.INTERNAL_ERROR,
      isOperational: false,
      ...options,
    });
  }
}

module.exports = ApiError;
```

### `src/utils/ApiResponse.js`

<sub>33 lines</sub>

```javascript
'use strict';

const httpStatus = require('./httpStatus');

/**
 * Every successful response has the same envelope, so clients can be written
 * against one contract: { success, message, data, meta }.
 */
class ApiResponse {
  constructor(data = null, message = 'Success', meta = undefined) {
    this.success = true;
    this.message = message;
    this.data = data;
    if (meta !== undefined) {
      this.meta = meta;
    }
  }

  /**
   * @param {import('express').Response} res
   * @param {object} [options]
   */
  static send(res, { statusCode = httpStatus.OK, data = null, message = 'Success', meta } = {}) {
    const payload = new ApiResponse(data, message, meta);
    payload.requestId = res.req && res.req.id ? res.req.id : undefined;
    if (payload.requestId === undefined) {
      delete payload.requestId;
    }
    return res.status(statusCode).json(payload);
  }
}

module.exports = ApiResponse;
```

### `src/utils/catchAsync.js`

<sub>25 lines</sub>

```javascript
'use strict';

/**
 * Wraps a route handler so that failures always reach Express' error pipeline
 * instead of becoming an unhandled rejection.
 *
 * Both rejection styles are covered: a rejected promise from an `async` handler
 * and a synchronous `throw` from a plain one.
 *
 * @param {Function} fn
 * @returns {import('express').RequestHandler}
 */
const catchAsync = (fn) => (req, res, next) => {
  try {
    const result = fn(req, res, next);
    if (result && typeof result.then === 'function') {
      return result.catch(next);
    }
    return result;
  } catch (error) {
    return next(error);
  }
};

module.exports = catchAsync;
```

### `src/utils/errorCodes.js`

<sub>27 lines</sub>

```javascript
'use strict';

/**
 * Stable, machine readable error codes. Clients (including the Flutter app)
 * should branch on these instead of on human readable messages.
 */
module.exports = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};
```

### `src/utils/httpStatus.js`

<sub>62 lines</sub>

```javascript
'use strict';

/**
 * Local HTTP status constants. Kept in-repo (instead of an external package) so
 * the status contract can never change under the application from a dependency
 * upgrade.
 */
const httpStatus = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

const statusMessages = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const getStatusMessage = (code) =>
  Object.prototype.hasOwnProperty.call(statusMessages, code)
    ? // eslint-disable-next-line security/detect-object-injection
      statusMessages[code]
    : 'Unknown Status';

module.exports = Object.assign(httpStatus, { statusMessages, getStatusMessage });
```

### `src/utils/index.js`

<sub>10 lines</sub>

```javascript
'use strict';

module.exports = {
  ApiError: require('./ApiError'),
  ApiResponse: require('./ApiResponse'),
  catchAsync: require('./catchAsync'),
  errorCodes: require('./errorCodes'),
  httpStatus: require('./httpStatus'),
  pick: require('./pick'),
};
```

### `src/utils/pick.js`

<sub>24 lines</sub>

```javascript
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
```

---

## Config

Environment parsing and cross-cutting setup. `config.js` validates every variable with Joi at startup and refuses to boot on a bad one. `roles.js` is the single place roles map to rights.

```
src/config/config.js
src/config/constants.js
src/config/database.js
src/config/index.js
src/config/logger.js
src/config/morgan.js
src/config/roles.js
src/config/tokenTypes.js
```

### `src/config/config.js`

<sub>112 lines</sub>

```javascript
'use strict';

const path = require('path');
const dotenv = require('dotenv');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * Every environment variable the application depends on is declared and validated
 * here. The process fails fast when the environment is not usable, so a
 * misconfigured container never starts serving traffic.
 */
const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().port().default(5000),
    GATEWAY_PORT: Joi.number().port().default(8080),
    API_PREFIX: Joi.string().default('/api/v1'),
    SERVICE_NAME: Joi.string().default('core-service'),
    MONGODB_URL: Joi.string().required().description('MongoDB connection string'),
    MONGODB_AUTO_INDEX: Joi.boolean().default(true),
    JWT_SECRET: Joi.string()
      .min(32)
      .required()
      .description('JWT signing secret, minimum 32 characters'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(15),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number().default(10),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number().default(60),
    JWT_ISSUER: Joi.string().default('node-mongo-api-boilerplate'),
    JWT_AUDIENCE: Joi.string().default('node-mongo-api-boilerplate-clients'),
    BCRYPT_SALT_ROUNDS: Joi.number().min(10).max(15).default(12),
    LOGIN_MAX_ATTEMPTS: Joi.number().min(1).default(5),
    LOGIN_LOCK_MINUTES: Joi.number().min(1).default(15),
    RATE_LIMIT_WINDOW_MINUTES: Joi.number().default(15),
    RATE_LIMIT_MAX: Joi.number().default(300),
    AUTH_RATE_LIMIT_MAX: Joi.number().default(20),
    CORS_ORIGINS: Joi.string()
      .default('*')
      .description('Comma separated list of allowed origins, or * for all'),
    TRUST_PROXY: Joi.number().min(0).default(1),
    BODY_LIMIT: Joi.string().default('100kb'),
    LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),
    CORE_SERVICE_URL: Joi.string().uri().default('http://127.0.0.1:5000'),
    GATEWAY_PROXY_TIMEOUT_MS: Joi.number().default(30000),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: 'key' }, abortEarly: false })
  .validate(process.env);

if (error) {
  throw new Error(`Invalid environment configuration: ${error.message}`);
}

const parseOrigins = (origins) =>
  origins === '*'
    ? '*'
    : origins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

module.exports = {
  env: envVars.NODE_ENV,
  isProduction: envVars.NODE_ENV === 'production',
  isTest: envVars.NODE_ENV === 'test',
  serviceName: envVars.SERVICE_NAME,
  port: envVars.PORT,
  gatewayPort: envVars.GATEWAY_PORT,
  apiPrefix: envVars.API_PREFIX,
  trustProxy: envVars.TRUST_PROXY,
  bodyLimit: envVars.BODY_LIMIT,
  logLevel: envVars.LOG_LEVEL,
  corsOrigins: parseOrigins(envVars.CORS_ORIGINS),
  mongoose: {
    url: envVars.MONGODB_URL,
    options: {
      autoIndex: envVars.MONGODB_AUTO_INDEX,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 20,
      minPoolSize: 1,
    },
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    issuer: envVars.JWT_ISSUER,
    audience: envVars.JWT_AUDIENCE,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  security: {
    bcryptSaltRounds: envVars.BCRYPT_SALT_ROUNDS,
    loginMaxAttempts: envVars.LOGIN_MAX_ATTEMPTS,
    loginLockMinutes: envVars.LOGIN_LOCK_MINUTES,
  },
  rateLimit: {
    windowMs: envVars.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: envVars.RATE_LIMIT_MAX,
    authMax: envVars.AUTH_RATE_LIMIT_MAX,
  },
  gateway: {
    proxyTimeoutMs: envVars.GATEWAY_PROXY_TIMEOUT_MS,
    services: {
      core: envVars.CORE_SERVICE_URL,
    },
  },
};
```

### `src/config/constants.js`

<sub>10 lines</sub>

```javascript
'use strict';

/** Domain enums shared by models, validations and the OpenAPI document. */
module.exports = {
  TASK_STATUSES: ['todo', 'in_progress', 'done'],
  TASK_PRIORITIES: ['low', 'medium', 'high'],
  REQUEST_ID_HEADER: 'x-request-id',
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 10,
};
```

### `src/config/database.js`

<sub>49 lines</sub>

```javascript
'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

mongoose.set('strictQuery', true);
// NOTE: `sanitizeFilter` is deliberately NOT enabled globally - it would wrap
// every legitimate internal operator ($lt, $regex, ...) in $eq. Injection is
// blocked at the edges instead: express-mongo-sanitize strips `$`/`.` keys from
// request payloads and Joi rejects anything that is not the declared type.

let connectionPromise = null;

const registerConnectionEvents = () => {
  const { connection } = mongoose;
  connection.on('connected', () => logger.info('MongoDB connected'));
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (error) => logger.error(`MongoDB connection error: ${error.message}`));
};

/**
 * Connects to MongoDB exactly once per process and reuses the promise so that
 * concurrent callers (server bootstrap, tests) never open competing pools.
 */
const connect = async (url = config.mongoose.url, options = config.mongoose.options) => {
  if (connectionPromise) {
    return connectionPromise;
  }
  registerConnectionEvents();
  connectionPromise = mongoose.connect(url, options).then(() => mongoose.connection);
  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
};

const disconnect = async () => {
  connectionPromise = null;
  await mongoose.disconnect();
};

/** 1 === connected. Used by the readiness probe so orchestrators can gate traffic. */
const isConnected = () => mongoose.connection.readyState === 1;

module.exports = { connect, disconnect, isConnected, mongoose };
```

### `src/config/index.js`

<sub>10 lines</sub>

```javascript
'use strict';

module.exports = {
  config: require('./config'),
  logger: require('./logger'),
  database: require('./database'),
  roles: require('./roles'),
  constants: require('./constants'),
  tokenTypes: require('./tokenTypes'),
};
```

### `src/config/logger.js`

<sub>45 lines</sub>

```javascript
'use strict';

const winston = require('winston');
const config = require('./config');

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    return Object.assign({}, info, { message: info.stack });
  }
  return info;
});

const developmentFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const context = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${context}`;
  })
);

/** Production logs are JSON so they can be shipped to any log aggregator as-is. */
const productionFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: { service: config.serviceName, env: config.env },
  format: config.isProduction ? productionFormat : developmentFormat,
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      silent: config.isTest,
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
```

### `src/config/morgan.js`

<sub>30 lines</sub>

```javascript
'use strict';

const morgan = require('morgan');
const config = require('./config');
const logger = require('./logger');

morgan.token('request-id', (req) => req.id || '-');
morgan.token('error-message', (req, res) => res.locals.errorMessage || '-');

const baseFormat =
  ':remote-addr :method :url :status :res[content-length] - :response-time ms rid=:request-id';

const successResponseFormat = baseFormat;
const errorResponseFormat = `${baseFormat} - error: :error-message`;

const successHandler = morgan(successResponseFormat, {
  skip: (req, res) => res.statusCode >= 400,
  stream: { write: (message) => logger.http(message.trim()) },
});

const errorHandler = morgan(errorResponseFormat, {
  skip: (req, res) => res.statusCode < 400,
  stream: { write: (message) => logger.warn(message.trim()) },
});

module.exports = {
  successHandler,
  errorHandler,
  enabled: !config.isTest,
};
```

### `src/config/roles.js`

<sub>21 lines</sub>

```javascript
'use strict';

/**
 * Role based access control map. A right is a coarse grained permission that
 * routes declare; the auth middleware resolves the caller's role to its rights.
 */
const allRoles = {
  user: ['tasks:manage-own', 'profile:manage-own'],
  admin: [
    'tasks:manage-own',
    'profile:manage-own',
    'tasks:manage-any',
    'users:read',
    'users:write',
  ],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

module.exports = { roles, roleRights, allRoles };
```

### `src/config/tokenTypes.js`

<sub>8 lines</sub>

```javascript
'use strict';

module.exports = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  RESET_PASSWORD: 'resetPassword',
  VERIFY_EMAIL: 'verifyEmail',
};
```

---

## Gateway

A separate process in front of the service: registry, proxy, circuit breaker, health aggregation, and it serves the test console.

It mounts no body parser on purpose, so request bodies stream straight through instead of being buffered and re-serialised.

```
src/gateway/circuitBreaker.js
src/gateway/gateway.js
src/gateway/index.js
src/gateway/registry.js
```

### `src/gateway/circuitBreaker.js`

<sub>59 lines</sub>

```javascript
'use strict';

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

/**
 * Minimal circuit breaker used by the gateway to stop hammering an upstream that
 * is already failing. After `failureThreshold` consecutive failures the circuit
 * opens and requests are rejected with 503 for `cooldownMs`; the next request
 * after the cooldown is let through as a probe (half-open).
 */
class CircuitBreaker {
  constructor({ name = 'upstream', failureThreshold = 5, cooldownMs = 15000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.openedAt = null;
  }

  /** @returns {boolean} true when requests must be rejected immediately. */
  isOpen() {
    if (this.state !== STATES.OPEN) {
      return false;
    }
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = STATES.HALF_OPEN;
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
    this.state = STATES.CLOSED;
  }

  recordFailure() {
    this.failures += 1;
    if (this.state === STATES.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.state = STATES.OPEN;
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
    };
  }
}

CircuitBreaker.STATES = STATES;

module.exports = CircuitBreaker;
```

### `src/gateway/gateway.js`

<sub>231 lines</sub>

```javascript
'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { createProxyMiddleware } = require('http-proxy-middleware');

const config = require('../config/config');
const logger = require('../config/logger');
const morgan = require('../config/morgan');
const { services } = require('./registry');
const requestId = require('../middlewares/requestId.middleware');
const { generalLimiter } = require('../middlewares/rateLimiter.middleware');
const {
  errorConverter,
  errorHandler,
  notFoundHandler,
} = require('../middlewares/error.middleware');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');
const { REQUEST_ID_HEADER } = require('../config/constants');

const PUBLIC_DIR = path.join(__dirname, '../../public');

const app = express();

app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(requestId);

if (morgan.enabled) {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// The gateway is the only component that serves HTML, so it carries the strict
// policy for the test console: no inline scripts, fonts from Google only.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'"],
        // Helmet enables this by default; over plain http on a LAN address it
        // would upgrade the page's own assets to https and break them.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

app.use(
  cors({
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  })
);

app.use(compression());

/** Gateway liveness: answers even when every upstream is down. */
app.get('/gateway/health', (req, res) =>
  ApiResponse.send(res, {
    message: 'Gateway is live',
    data: {
      status: 'up',
      service: 'api-gateway',
      env: config.env,
      timestamp: new Date().toISOString(),
    },
  })
);

/** Aggregated readiness: one call tells you the state of the whole mesh. */
app.get('/gateway/health/services', async (req, res, next) => {
  try {
    const report = await Promise.all(
      services.map(async (service) => {
        const start = Date.now();
        try {
          const response = await fetch(`${service.target}${service.healthPath}`, {
            signal: AbortSignal.timeout(3000),
            headers: { [REQUEST_ID_HEADER]: req.id },
          });
          return {
            name: service.name,
            target: service.target,
            status: response.ok ? 'up' : 'degraded',
            httpStatus: response.status,
            latencyMs: Date.now() - start,
            circuit: service.breaker.snapshot(),
          };
        } catch (error) {
          return {
            name: service.name,
            target: service.target,
            status: 'down',
            error: error.name === 'TimeoutError' ? 'timeout' : error.message,
            latencyMs: Date.now() - start,
            circuit: service.breaker.snapshot(),
          };
        }
      })
    );

    const allUp = report.every((service) => service.status === 'up');
    return ApiResponse.send(res, {
      statusCode: allUp ? httpStatus.OK : httpStatus.SERVICE_UNAVAILABLE,
      message: allUp ? 'All services are reachable' : 'One or more services are unavailable',
      data: { services: report },
    });
  } catch (error) {
    return next(error);
  }
});

/** Route table, handy when onboarding a new client. */
app.get('/gateway/routes', (req, res) =>
  ApiResponse.send(res, {
    message: 'Registered upstreams',
    data: {
      routes: services.map(({ name, prefix, target, breaker }) => ({
        name,
        prefix,
        target,
        circuit: breaker.snapshot(),
      })),
    },
  })
);

// Rate limiting is enforced at the edge, before anything is forwarded.
app.use(config.apiPrefix, generalLimiter);

services.forEach((service) => {
  // Reject fast while the upstream is known to be failing.
  app.use(service.prefix, (req, res, next) => {
    if (service.breaker.isOpen()) {
      return next(
        new ApiError(
          httpStatus.SERVICE_UNAVAILABLE,
          `Service '${service.name}' is temporarily unavailable`,
          { code: errorCodes.SERVICE_UNAVAILABLE }
        )
      );
    }
    return next();
  });

  app.use(
    createProxyMiddleware({
      // Matched at the app root (rather than mounted with app.use('/prefix')),
      // so the original path reaches the upstream untouched. A predicate is used
      // instead of a glob to make the boundary exact: `/api/v1` and everything
      // under it, and nothing else.
      pathFilter: (pathname) =>
        pathname === service.prefix || pathname.startsWith(`${service.prefix}/`),
      target: service.target,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: config.gateway.proxyTimeoutMs,
      timeout: config.gateway.proxyTimeoutMs,
      logger: { info: () => {}, warn: (m) => logger.warn(m), error: (m) => logger.error(m) },
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.setHeader(REQUEST_ID_HEADER, req.id);
          proxyReq.setHeader('x-gateway', 'api-gateway');
        },
        proxyRes: (proxyRes, req, res) => {
          service.breaker.recordSuccess();
          res.setHeader('x-upstream-service', service.name);
        },
        error: (error, req, res, next) => {
          service.breaker.recordFailure();
          const isTimeout = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
          const apiError = new ApiError(
            isTimeout ? httpStatus.GATEWAY_TIMEOUT : httpStatus.BAD_GATEWAY,
            isTimeout
              ? `Service '${service.name}' did not respond in time`
              : `Service '${service.name}' is unreachable`,
            { code: isTimeout ? errorCodes.GATEWAY_TIMEOUT : errorCodes.SERVICE_UNAVAILABLE }
          );
          logger.error(`Proxy error for ${service.name}: ${error.message}`, { requestId: req.id });
          if (typeof next === 'function') {
            return next(apiError);
          }
          if (res && !res.headersSent && typeof res.status === 'function') {
            return res.status(apiError.statusCode).json({
              success: false,
              code: apiError.code,
              message: apiError.message,
              requestId: req.id,
            });
          }
          return undefined;
        },
      },
    })
  );
});

// The end-to-end test console.
app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    maxAge: config.isProduction ? '1h' : 0,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

app.use(notFoundHandler);
app.use(errorConverter);
app.use(errorHandler);

module.exports = app;
```

### `src/gateway/index.js`

<sub>47 lines</sub>

```javascript
'use strict';

const gateway = require('./gateway');
const config = require('../config/config');
const logger = require('../config/logger');

const server = gateway.listen(config.gatewayPort, () => {
  logger.info(`api-gateway listening on port ${config.gatewayPort} [${config.env}]`);
  logger.info(`Test console: http://localhost:${config.gatewayPort}/`);
  logger.info(`Proxying ${config.apiPrefix}/* -> ${config.gateway.services.core}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.gatewayPort} is already in use`);
  } else {
    logger.error(`Gateway server error: ${error.message}`);
  }
  process.exit(1);
});

const shutdown = (signal, exitCode = 0) => {
  logger.info(`${signal} received, stopping gateway`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(() => {
    logger.info('Gateway stopped');
    process.exit(exitCode);
  });
};

process.on('uncaughtException', (error) => {
  logger.error(`Gateway uncaught exception: ${error.stack || error.message}`);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Gateway unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  shutdown('unhandledRejection', 1);
});

['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal, 0)));

module.exports = server;
```

### `src/gateway/registry.js`

<sub>23 lines</sub>

```javascript
'use strict';

const config = require('../config/config');
const CircuitBreaker = require('./circuitBreaker');

/**
 * Service registry. Adding a second microservice is a matter of appending an
 * entry here: the gateway derives routing, health aggregation and circuit
 * breaking from this list.
 */
const services = [
  {
    name: 'core',
    prefix: config.apiPrefix,
    target: config.gateway.services.core,
    healthPath: `${config.apiPrefix}/health/ready`,
    breaker: new CircuitBreaker({ name: 'core', failureThreshold: 5, cooldownMs: 15000 }),
  },
];

const getService = (name) => services.find((service) => service.name === name);

module.exports = { services, getService };
```

---

## Scripts

`seed.js` populates a development database. `smoke.js` is the command-line twin of the browser console: the same fifteen checks, exiting non-zero on the first mismatch, so it works as a post-deploy gate.

```
src/scripts/seed.js
src/scripts/smoke.js
```

### `src/scripts/seed.js`

<sub>68 lines</sub>

```javascript
'use strict';

/**
 * Seeds a development database with an admin, a regular user and a few tasks.
 * Refuses to run against NODE_ENV=production.
 *
 *   npm run seed
 */
const config = require('../config/config');
const database = require('../config/database');
const { User, Task } = require('../models');

const ADMIN = {
  name: 'Admin User',
  email: 'admin@example.com',
  password: 'Adm1n!Pass1',
  role: 'admin',
  isEmailVerified: true,
};

const MEMBER = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'Str0ng!Pass1',
  role: 'user',
  isEmailVerified: true,
};

const TASKS = [
  { title: 'Read the README', priority: 'high', status: 'todo', tags: ['onboarding'] },
  { title: 'Run the test suite', priority: 'medium', status: 'in_progress' },
  { title: 'Open the smoke console', priority: 'low', status: 'done' },
];

const upsertUser = async (payload) => {
  const existing = await User.findOne({ email: payload.email });
  if (existing) {
    return existing;
  }
  return User.create(payload);
};

const run = async () => {
  if (config.isProduction) {
    throw new Error('Refusing to seed a production database');
  }

  await database.connect();

  const admin = await upsertUser(ADMIN);
  const member = await upsertUser(MEMBER);

  await Task.deleteMany({ owner: member._id });
  await Task.create(TASKS.map((task) => ({ ...task, owner: member._id })));

  console.log('Seeded:');
  console.log(`  admin  ${ADMIN.email} / ${ADMIN.password} (id ${admin.id})`);
  console.log(`  user   ${MEMBER.email} / ${MEMBER.password} (id ${member.id})`);
  console.log(`  tasks  ${TASKS.length} owned by ${MEMBER.email}`);

  await database.disconnect();
};

run().catch(async (error) => {
  console.error(`Seed failed: ${error.message}`);
  await database.disconnect().catch(() => {});
  process.exit(1);
});
```

### `src/scripts/smoke.js`

<sub>212 lines</sub>

```javascript
'use strict';

/**
 * Command line twin of the browser console: drives the same fifteen calls
 * against a running deployment and exits non-zero on the first mismatch.
 * Point it at any environment:
 *
 *   node src/scripts/smoke.js                       # http://localhost:8080
 *   node src/scripts/smoke.js https://api.example.com
 */
const config = require('../config/config');

const BASE = (process.argv[2] || `http://127.0.0.1:${config.gatewayPort}`).replace(/\/$/, '');
const API = `${BASE}${config.apiPrefix}`;

const session = {
  accessToken: null,
  refreshToken: null,
  user: null,
  taskId: null,
  spentRefresh: null,
};

const call = async (method, url, { body, token } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, body: { message: error.message }, ms: Date.now() - startedAt };
  }
};

const email = `smoke+${Date.now()}@example.com`;
const password = 'Str0ng!Pass1';

const steps = [
  {
    name: 'Gateway reaches the core service',
    run: () => call('GET', `${BASE}/gateway/health/services`),
    check: (r) => r.status === 200,
  },
  {
    name: 'Service is connected to MongoDB',
    run: () => call('GET', `${API}/health/ready`),
    check: (r) => r.status === 200 && r.body.data.dependencies.mongodb === 'up',
  },
  {
    name: 'Register issues a token pair',
    run: () =>
      call('POST', `${API}/auth/register`, { body: { name: 'Ada Lovelace', email, password } }),
    check: (r) => {
      if (r.status !== 201) {
        return false;
      }
      session.accessToken = r.body.data.tokens.access.token;
      session.refreshToken = r.body.data.tokens.refresh.token;
      session.user = r.body.data.user;
      return true;
    },
  },
  {
    name: 'Duplicate email is refused',
    run: () =>
      call('POST', `${API}/auth/register`, { body: { name: 'Ada Lovelace', email, password } }),
    check: (r) => r.status === 409 && r.body.code === 'EMAIL_ALREADY_EXISTS',
  },
  {
    name: 'Weak password is refused with field detail',
    run: () =>
      call('POST', `${API}/auth/register`, {
        body: { name: 'Weak', email: `weak+${Date.now()}@example.com`, password: 'password' },
      }),
    check: (r) => r.status === 400 && r.body.details.some((detail) => detail.field === 'password'),
  },
  {
    name: 'Login returns a fresh token pair',
    run: () => call('POST', `${API}/auth/login`, { body: { email, password } }),
    check: (r) => {
      if (r.status !== 200) {
        return false;
      }
      session.accessToken = r.body.data.tokens.access.token;
      session.refreshToken = r.body.data.tokens.refresh.token;
      return true;
    },
  },
  {
    name: 'Wrong password is refused',
    run: () => call('POST', `${API}/auth/login`, { body: { email, password: 'Wr0ng!Pass1' } }),
    check: (r) => r.status === 401 && r.body.code === 'INVALID_CREDENTIALS',
  },
  {
    name: 'Access token identifies the caller',
    run: () => call('GET', `${API}/auth/me`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.data.user.email === email,
  },
  {
    name: 'Missing token is refused',
    run: () => call('GET', `${API}/tasks`),
    check: (r) => r.status === 401 && r.body.code === 'UNAUTHENTICATED',
  },
  {
    name: 'Task is created and owned by the caller',
    run: () =>
      call('POST', `${API}/tasks`, {
        token: session.accessToken,
        body: { title: 'Verify the deployment', priority: 'high', tags: ['smoke'] },
      }),
    check: (r) => {
      if (r.status !== 201) {
        return false;
      }
      session.taskId = r.body.data.task.id;
      return r.body.data.task.owner === session.user.id;
    },
  },
  {
    name: 'List returns pagination metadata',
    run: () =>
      call('GET', `${API}/tasks?limit=5&sortBy=createdAt:desc`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.meta.totalResults >= 1,
  },
  {
    name: 'Closing a task stamps completion',
    run: () =>
      call('PATCH', `${API}/tasks/${session.taskId}`, {
        token: session.accessToken,
        body: { status: 'done' },
      }),
    check: (r) =>
      r.status === 200 && r.body.data.task.status === 'done' && !!r.body.data.task.completedAt,
  },
  {
    name: 'Counts are scoped to the caller',
    run: () => call('GET', `${API}/tasks/stats`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.data.done === 1,
  },
  {
    name: 'Refresh token rotates',
    run: async () => {
      session.spentRefresh = session.refreshToken;
      const result = await call('POST', `${API}/auth/refresh-tokens`, {
        body: { refreshToken: session.spentRefresh },
      });
      if (result.status === 200) {
        session.accessToken = result.body.data.tokens.access.token;
        session.refreshToken = result.body.data.tokens.refresh.token;
      }
      return result;
    },
    check: (r) => r.status === 200 && session.refreshToken !== session.spentRefresh,
  },
  {
    name: 'Spent refresh token cannot be replayed',
    run: () =>
      call('POST', `${API}/auth/refresh-tokens`, { body: { refreshToken: session.spentRefresh } }),
    check: (r) => r.status === 401 && r.body.code === 'TOKEN_INVALID',
  },
];

const main = async () => {
  console.log(`Smoke test against ${BASE}\n`);
  let passed = 0;

  for (const [index, step] of steps.entries()) {
    // Steps depend on each other, so they must run in order.
    // eslint-disable-next-line no-await-in-loop
    const result = await step.run();
    let ok = false;
    try {
      ok = step.check(result);
    } catch {
      ok = false;
    }
    const number = String(index + 1).padStart(2, '0');
    const verdict = ok ? 'pass' : 'FAIL';
    console.log(
      `${number}  ${verdict}  ${String(result.status).padStart(3)}  ${String(result.ms).padStart(5)}ms  ${step.name}`
    );
    if (ok) {
      passed += 1;
    } else {
      console.log(`      expected otherwise, got: ${JSON.stringify(result.body)}\n`);
    }
  }

  console.log(`\n${passed}/${steps.length} checks passed`);
  process.exit(passed === steps.length ? 0 : 1);
};

main();
```

---

## API documentation

The OpenAPI 3.0 document, served at `/api/v1/docs` outside production.

```
src/docs/openapi.js
```

### `src/docs/openapi.js`

<sub>463 lines</sub>

```javascript
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
```

---

## Not included above

Two folders are on disk but left out of this walkthrough, since neither is
an application layer:

- `public/` — the browser test console (`index.html`,
  `assets/console.css`, `assets/console.js`), 1,625 lines.
- `tests/` — 11 suites, 188 tests, 2,239 lines.

