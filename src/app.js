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
app.use(hpp({ whitelist: ['sortBy', 'status'] }));

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
