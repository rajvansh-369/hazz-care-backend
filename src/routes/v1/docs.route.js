'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openApiDocument = require('../../docs/openapi');

const router = express.Router();

router.get('/openapi.json', (req, res) => res.json(openApiDocument));
router.use('/', swaggerUi.serve, swaggerUi.setup(openApiDocument, { explorer: false }));

module.exports = router;
