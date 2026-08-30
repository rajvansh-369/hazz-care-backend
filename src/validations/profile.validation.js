'use strict';

const { z } = require('zod');

const updatePersonalInfoSchema = z.object({
  firstName: z.string().max(40, 'First name must be at most 40 characters').optional(),
  lastName: z.string().max(40, 'Last name must be at most 40 characters').optional(),
  phone: z.string().max(20, 'Phone must be at most 20 characters').optional(),
  dob: z.string().datetime().optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  countryCode: z.string().max(2, 'Country code must be at most 2 characters').optional(),
  locale: z.enum(['en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr']).optional(),
  bloodType: z.enum(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']).optional(),
  heightCm: z
    .number()
    .min(50, 'Height must be at least 50 cm')
    .max(250, 'Height must be at most 250 cm')
    .optional(),
  weightKg: z
    .number()
    .min(20, 'Weight must be at least 20 kg')
    .max(300, 'Weight must be at most 300 kg')
    .optional(),
});

const createEmergencyContactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(80, 'Name must be at most 80 characters'),
  relationship: z.enum(['spouse', 'child', 'parent', 'sibling', 'friend', 'other']),
  phone: z.string().min(1, 'Phone is required').max(20, 'Phone must be at most 20 characters'),
  whatsappNumber: z.string().max(20, 'WhatsApp number must be at most 20 characters').optional(),
  isPrimary: z.boolean().optional(),
  notifyOrder: z
    .number()
    .min(1, 'Notify order must be at least 1')
    .max(5, 'Notify order must be at most 5')
    .optional(),
  locale: z.enum(['en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr']).optional(),
});

const updateEmergencyContactSchema = z.object({
  name: z.string().max(80, 'Name must be at most 80 characters').optional(),
  relationship: z.enum(['spouse', 'child', 'parent', 'sibling', 'friend', 'other']).optional(),
  phone: z.string().max(20, 'Phone must be at most 20 characters').optional(),
  whatsappNumber: z.string().max(20, 'WhatsApp number must be at most 20 characters').optional(),
  isPrimary: z.boolean().optional(),
  notifyOrder: z
    .number()
    .min(1, 'Notify order must be at least 1')
    .max(5, 'Notify order must be at most 5')
    .optional(),
  locale: z.enum(['en', 'ar', 'ur', 'id', 'fr', 'bn', 'tr']).optional(),
});

module.exports = {
  updatePersonalInfoSchema,
  createEmergencyContactSchema,
  updateEmergencyContactSchema,
};
