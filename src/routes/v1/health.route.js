'use strict';

const express = require('express');
const { healthController } = require('../../controllers');

const router = express.Router();

router.get('/', healthController.live);
router.get('/live', healthController.live);
router.get('/ready', healthController.ready);

module.exports = router;
