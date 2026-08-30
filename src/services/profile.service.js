'use strict';

const User = require('../models/user.model');
const EmergencyContact = require('../models/emergencyContact.model');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

/**
 * Get user personal info
 * @param {string} userId
 * @returns {Promise<object>}
 */
const getPersonalInfo = async (userId) => {
  const user = await User.findById(userId).select(
    'firstName lastName email phone dob gender countryCode locale bloodType heightCm weightKg'
  );
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  return user;
};

/**
 * Update user personal info
 * @param {string} userId
 * @param {object} updateBody
 * @returns {Promise<object>}
 */
const updatePersonalInfo = async (userId, updateBody) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  Object.assign(user, updateBody);
  await user.save();
  return user;
};

/**
 * Create emergency contact
 * @param {string} userId
 * @param {object} contactBody
 * @returns {Promise<object>}
 */
const createEmergencyContact = async (userId, contactBody) => {
  // Check user exists
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  // Check max 5 emergency contacts
  const contactCount = await EmergencyContact.countDocuments({ userId });
  if (contactCount >= 5) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Maximum 5 emergency contacts allowed');
  }

  const contact = await EmergencyContact.create({
    userId,
    ...contactBody,
  });

  return contact;
};

/**
 * Get emergency contacts
 * @param {string} userId
 * @returns {Promise<array>}
 */
const getEmergencyContacts = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const contacts = await EmergencyContact.find({ userId }).sort({ notifyOrder: 1 });
  return contacts;
};

/**
 * Get emergency contact by ID
 * @param {string} userId
 * @param {string} contactId
 * @returns {Promise<object>}
 */
const getEmergencyContactById = async (userId, contactId) => {
  const contact = await EmergencyContact.findOne({ _id: contactId, userId });
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Emergency contact not found');
  }
  return contact;
};

/**
 * Update emergency contact
 * @param {string} userId
 * @param {string} contactId
 * @param {object} updateBody
 * @returns {Promise<object>}
 */
const updateEmergencyContact = async (userId, contactId, updateBody) => {
  const contact = await EmergencyContact.findOneAndUpdate(
    { _id: contactId, userId },
    updateBody,
    { new: true, runValidators: true }
  );
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Emergency contact not found');
  }
  return contact;
};

/**
 * Delete emergency contact
 * @param {string} userId
 * @param {string} contactId
 * @returns {Promise<void>}
 */
const deleteEmergencyContact = async (userId, contactId) => {
  const contact = await EmergencyContact.findOneAndDelete({ _id: contactId, userId });
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Emergency contact not found');
  }
};

module.exports = {
  getPersonalInfo,
  updatePersonalInfo,
  createEmergencyContact,
  getEmergencyContacts,
  getEmergencyContactById,
  updateEmergencyContact,
  deleteEmergencyContact,
};
