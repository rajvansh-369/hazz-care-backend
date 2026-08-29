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
