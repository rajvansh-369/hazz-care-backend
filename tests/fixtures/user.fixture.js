'use strict';

const mongoose = require('mongoose');
const { User } = require('../../src/models');

const password = 'Str0ng!Pass1';
const anotherPassword = 'An0ther!Pass2';

const userOne = {
  _id: new mongoose.Types.ObjectId(),
  name: 'User One',
  email: 'user.one@example.com',
  password,
  role: 'user',
  isEmailVerified: false,
  isActive: true,
};

const userTwo = {
  _id: new mongoose.Types.ObjectId(),
  name: 'User Two',
  email: 'user.two@example.com',
  password,
  role: 'user',
  isEmailVerified: false,
  isActive: true,
};

const admin = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Admin User',
  email: 'admin@example.com',
  password,
  role: 'admin',
  isEmailVerified: true,
  isActive: true,
};

/**
 * Inserts through `User.create` on purpose: the password hashing hook is part of
 * the behaviour under test, so fixtures must not bypass it.
 */
const insertUsers = async (users) => {
  await User.create(users.map((user) => ({ ...user })));
};

module.exports = { password, anotherPassword, userOne, userTwo, admin, insertUsers };
