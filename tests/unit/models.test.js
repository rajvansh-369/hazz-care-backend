'use strict';

const mongoose = require('mongoose');
const { User, Task } = require('../../src/models');

describe('toJSON plugin', () => {
  test('exposes id, hides _id, __v and private paths', () => {
    const user = new User({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Str0ng!Pass1',
      loginAttempts: 3,
    });

    const json = user.toJSON();
    expect(json.id).toBe(user._id.toString());
    expect(json._id).toBeUndefined();
    expect(json.__v).toBeUndefined();
    expect(json.password).toBeUndefined();
    expect(json.loginAttempts).toBeUndefined();
    expect(json.lockUntil).toBeUndefined();
    expect(json.name).toBe('Ada Lovelace');
  });

  test('survives JSON.stringify without leaking the password', () => {
    const user = new User({ name: 'Ada', email: 'ada@example.com', password: 'Str0ng!Pass1' });
    expect(JSON.stringify(user)).not.toContain('Str0ng!Pass1');
  });
});

describe('User model validation', () => {
  const build = (overrides) =>
    new User({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Str0ng!Pass1',
      ...overrides,
    });

  test('accepts a valid user', () => {
    expect(build().validateSync()).toBeUndefined();
  });

  test('normalises the email', () => {
    expect(build({ email: '  ADA@Example.COM  ' }).email).toBe('ada@example.com');
  });

  test.each([
    ['malformed email', { email: 'not-an-email' }, 'email'],
    ['short name', { name: 'A' }, 'name'],
    ['weak password', { password: 'weakpass' }, 'password'],
    ['unknown role', { role: 'root' }, 'role'],
  ])('rejects a %s', (_label, overrides, path) => {
    const error = build(overrides).validateSync();
    expect(error.errors[path]).toBeDefined();
  });

  test('defaults role, active flag and verification flag', () => {
    const user = build();
    expect(user.role).toBe('user');
    expect(user.isActive).toBe(true);
    expect(user.isEmailVerified).toBe(false);
  });

  test('isLocked reflects the lock window', () => {
    const user = build();
    expect(user.isLocked()).toBe(false);
    user.lockUntil = new Date(Date.now() + 60000);
    expect(user.isLocked()).toBe(true);
    user.lockUntil = new Date(Date.now() - 60000);
    expect(user.isLocked()).toBe(false);
  });
});

describe('Task model validation', () => {
  const owner = new mongoose.Types.ObjectId();
  const build = (overrides) => new Task({ title: 'A valid title', owner, ...overrides });

  test('accepts a valid task and applies defaults', () => {
    const task = build();
    expect(task.validateSync()).toBeUndefined();
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('medium');
    expect(task.tags).toEqual([]);
  });

  test.each([
    ['missing owner', { owner: undefined }, 'owner'],
    ['short title', { title: 'ab' }, 'title'],
    ['unknown status', { status: 'archived' }, 'status'],
    ['too many tags', { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }, 'tags'],
  ])('rejects %s', (_label, overrides, path) => {
    expect(build(overrides).validateSync().errors[path]).toBeDefined();
  });
});
