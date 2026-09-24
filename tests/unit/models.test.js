'use strict';

const { User } = require('../../src/models');

describe('toJSON plugin', () => {
  test('exposes id as a non-empty string and hides _id, __v and passwordHash', () => {
    const user = new User({
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      passwordHash: 'not-a-real-hash-value',
    });

    const json = JSON.parse(JSON.stringify(user));
    expect(typeof json.id).toBe('string');
    expect(json.id.trim().length).toBeGreaterThan(0);
    expect(json.id).toBe(user._id.toString());
    expect(json).not.toHaveProperty('_id');
    expect(json).not.toHaveProperty('__v');
    expect(json).not.toHaveProperty('passwordHash');
    expect(json.fullName).toBe('Ada Lovelace');
  });

  test('survives JSON.stringify without leaking the password hash', () => {
    const user = new User({
      fullName: 'Ada',
      email: 'ada@example.com',
      passwordHash: 'not-a-real-hash-value',
    });
    expect(JSON.stringify(user)).not.toContain('not-a-real-hash-value');
  });
});
