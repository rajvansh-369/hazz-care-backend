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
