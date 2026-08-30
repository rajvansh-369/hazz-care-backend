'use strict';

const express = require('express');
const auth = require('../../middlewares/auth.middleware');
const profileController = require('../../controllers/profile.controller');

const router = express.Router();

// Personal info routes
router.get('/', auth(), profileController.getPersonalInfo);
router.put('/', auth(), profileController.updatePersonalInfo);

// Emergency contact routes
router.get('/emergency-contacts', auth(), profileController.getEmergencyContacts);
router.post('/emergency-contacts', auth(), profileController.createEmergencyContact);
router.get('/emergency-contacts/:contactId', auth(), profileController.getEmergencyContact);
router.put('/emergency-contacts/:contactId', auth(), profileController.updateEmergencyContact);
router.delete('/emergency-contacts/:contactId', auth(), profileController.deleteEmergencyContact);

module.exports = router;
