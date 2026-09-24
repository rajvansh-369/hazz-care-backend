'use strict';

const express = require('express');

const router = express.Router();

// Layer A has no /users endpoint. User data is returned by /auth/me only.

module.exports = router;
