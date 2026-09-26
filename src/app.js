'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

const config = require('./config/config');
const morgan = require('./config/morgan');
const routes = require('./routes/v1');
const requestId = require('./middlewares/requestId.middleware');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

const app = express();

// 1. Platform settings. No ETags: a 304 with an empty body would fail the client's
// parser. No redirects anywhere, no static files.
app.disable('x-powered-by');
app.set('etag', false);
// Disabling ETags is not enough: Express still answers 304 to `If-None-Match: *`
// on a GET (e.g. /auth/me), because `*` matches without an ETag. Conditional
// requests are never honoured here, so drop the headers before anything reads them.
app.use((req, res, next) => {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  next();
});
// Honour X-Forwarded-* from exactly `trustProxy` hops (0 = no reverse proxy).
app.set('trust proxy', config.trustProxy);

// 2. Correlation id first; it is echoed in the X-Request-Id response header so an
// error body never has to carry it.
app.use(requestId);

// 3. Request line logging: method, URL, status, time. Never bodies.
if (morgan.enabled) {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// 4. Security headers.
app.use(
  helmet({
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

// 5. CORS. Credentials are off: the client sends a bearer header and no cookies.
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
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 600,
};
app.use(cors(corsOptions));

// 6. RevenueCat webhook (CLAUDE.md A5, BACKEND_SPEC.md §6b), BEFORE express.json():
// its router reads the raw request bytes, which the HMAC signature is computed over.
// Server-to-server and outside the auth router, so the /auth status rules do not
// apply; it answers only 200, 400, 401 or 503.
app.use(`${config.apiPrefix}/webhooks`, require('./routes/v1/webhook.route'));

// 7. JSON body parsing with a hard ceiling. Malformed JSON → 400 and oversized
// bodies → 413, both {"code":"invalid_input"}, via the error handler.
app.use(express.json({ limit: '32kb' }));

// 8. Payload hygiene: strip Mongo operators ($gt, $where, ...) from bodies and queries.
app.use(mongoSanitize({ replaceWith: '_' }));

// 9. Response compression.
app.use(compression());

// 10. Health probes at the root as well, so orchestrators need not know the prefix.
app.use('/health', require('./routes/v1/health.route'));

// 11. Versioned API: /health and /auth. The auth router ends in its own 503 catch-all.
app.use(config.apiPrefix, routes);

// 12. Everything else → 404 {"code":"not_found"}, except a path with an "auth" segment
// that never reached the auth router (//api/v1/auth, %61uth, a wrong base URL...),
// which is 503 {"code":"unavailable"}, never 404 (CLAUDE.md A10 f).
app.use(notFoundHandler);

// 13. The error handler, last.
app.use(errorHandler);

module.exports = app;
