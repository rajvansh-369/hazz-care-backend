'use strict';

const httpStatus = require('http-status');
const profileService = require('../services/profile.service');
const { updatePersonalInfoSchema, createEmergencyContactSchema, updateEmergencyContactSchema } = require('../validations/profile.validation');

/**
 * Get personal info
 */
const getPersonalInfo = async (req, res, next) => {
  try {
    const personalInfo = await profileService.getPersonalInfo(req.user.id);
    res.status(httpStatus.OK).send({
      success: true,
      data: { personalInfo },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update personal info
 */
const updatePersonalInfo = async (req, res, next) => {
  try {
    const validated = updatePersonalInfoSchema.parse(req.body);
    const personalInfo = await profileService.updatePersonalInfo(req.user.id, validated);
    res.status(httpStatus.OK).send({
      success: true,
      data: { personalInfo },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create emergency contact
 */
const createEmergencyContact = async (req, res, next) => {
  try {
    const validated = createEmergencyContactSchema.parse(req.body);
    const contact = await profileService.createEmergencyContact(req.user.id, validated);
    res.status(httpStatus.CREATED).send({
      success: true,
      data: { emergencyContact: contact },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get emergency contacts
 */
const getEmergencyContacts = async (req, res, next) => {
  try {
    const contacts = await profileService.getEmergencyContacts(req.user.id);
    res.status(httpStatus.OK).send({
      success: true,
      data: { emergencyContacts: contacts },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get emergency contact by ID
 */
const getEmergencyContact = async (req, res, next) => {
  try {
    const contact = await profileService.getEmergencyContactById(req.user.id, req.params.contactId);
    res.status(httpStatus.OK).send({
      success: true,
      data: { emergencyContact: contact },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update emergency contact
 */
const updateEmergencyContact = async (req, res, next) => {
  try {
    const validated = updateEmergencyContactSchema.parse(req.body);
    const contact = await profileService.updateEmergencyContact(req.user.id, req.params.contactId, validated);
    res.status(httpStatus.OK).send({
      success: true,
      data: { emergencyContact: contact },
      meta: { requestId: req.id },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete emergency contact
 */
const deleteEmergencyContact = async (req, res, next) => {
  try {
    await profileService.deleteEmergencyContact(req.user.id, req.params.contactId);
    res.status(httpStatus.NO_CONTENT).send();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPersonalInfo,
  updatePersonalInfo,
  createEmergencyContact,
  getEmergencyContacts,
  getEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
};
