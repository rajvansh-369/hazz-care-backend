'use strict';

/**
 * Seeds a development database with an admin, a regular user and a few tasks.
 * Refuses to run against NODE_ENV=production.
 *
 *   npm run seed
 */
const config = require('../config/config');
const database = require('../config/database');
const { User, Task } = require('../models');

const ADMIN = {
  name: 'Admin User',
  email: 'admin@example.com',
  password: 'Adm1n!Pass1',
  role: 'admin',
  isEmailVerified: true,
};

const MEMBER = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'Str0ng!Pass1',
  role: 'user',
  isEmailVerified: true,
};

const TASKS = [
  { title: 'Read the README', priority: 'high', status: 'todo', tags: ['onboarding'] },
  { title: 'Run the test suite', priority: 'medium', status: 'in_progress' },
  { title: 'Open the smoke console', priority: 'low', status: 'done' },
];

const upsertUser = async (payload) => {
  const existing = await User.findOne({ email: payload.email });
  if (existing) {
    return existing;
  }
  return User.create(payload);
};

const run = async () => {
  if (config.isProduction) {
    throw new Error('Refusing to seed a production database');
  }

  await database.connect();

  const admin = await upsertUser(ADMIN);
  const member = await upsertUser(MEMBER);

  await Task.deleteMany({ owner: member._id });
  await Task.create(TASKS.map((task) => ({ ...task, owner: member._id })));

  console.log('Seeded:');
  console.log(`  admin  ${ADMIN.email} / ${ADMIN.password} (id ${admin.id})`);
  console.log(`  user   ${MEMBER.email} / ${MEMBER.password} (id ${member.id})`);
  console.log(`  tasks  ${TASKS.length} owned by ${MEMBER.email}`);

  await database.disconnect();
};

run().catch(async (error) => {
  console.error(`Seed failed: ${error.message}`);
  await database.disconnect().catch(() => {});
  process.exit(1);
});
