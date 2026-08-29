'use strict';

/**
 * Role based access control map. A right is a coarse grained permission that
 * routes declare; the auth middleware resolves the caller's role to its rights.
 */
const allRoles = {
  user: ['tasks:manage-own', 'profile:manage-own'],
  admin: [
    'tasks:manage-own',
    'profile:manage-own',
    'tasks:manage-any',
    'users:read',
    'users:write',
  ],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

module.exports = { roles, roleRights, allRoles };
