'use strict';

const express = require('express');
const authRoute = require('./auth.route');
const healthRoute = require('./health.route');

const router = express.Router();

const routes = [
  { path: '/health', route: healthRoute },
  { path: '/auth', route: authRoute },
];

routes.forEach(({ path, route }) => router.use(path, route));

module.exports = router;
