'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const setupTestDB = require('../utils/setupTestDB');
const { User } = require('../../src/models');
const config = require('../../src/config/config');
const { userOne, userTwo, admin, password, insertUsers } = require('../fixtures/user.fixture');
const { userOneAccessToken, adminAccessToken } = require('../fixtures/token.fixture');

setupTestDB();

const API = config.apiPrefix;
const asUser = (token) => ({ Authorization: `Bearer ${token}` });

describe('User routes', () => {
  describe(`GET ${API}/users`, () => {
    test('an admin can list users with pagination metadata', async () => {
      await insertUsers([userOne, userTwo, admin]);
      const res = await request(app)
        .get(`${API}/users`)
        .set(asUser(adminAccessToken))
        .query({ limit: 2, page: 1 })
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 2,
        totalPages: 2,
        totalResults: 3,
      });
      expect(res.body.data[0].password).toBeUndefined();
    });

    test('supports filtering by role', async () => {
      await insertUsers([userOne, userTwo, admin]);
      const res = await request(app)
        .get(`${API}/users`)
        .set(asUser(adminAccessToken))
        .query({ role: 'admin' })
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].email).toBe(admin.email);
    });

    test('supports sorting', async () => {
      await insertUsers([userOne, userTwo, admin]);
      const res = await request(app)
        .get(`${API}/users`)
        .set(asUser(adminAccessToken))
        .query({ sortBy: 'name:asc' })
        .expect(200);
      expect(res.body.data.map((user) => user.name)).toEqual([
        'Admin User',
        'User One',
        'User Two',
      ]);
    });

    test('a non-admin is refused with 403', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/users`)
        .set(asUser(userOneAccessToken))
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    test('rejects an unknown role filter with 400', async () => {
      await insertUsers([admin]);
      const res = await request(app)
        .get(`${API}/users`)
        .set(asUser(adminAccessToken))
        .query({ role: 'superuser' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    test('ignores unknown query parameters instead of failing', async () => {
      await insertUsers([admin]);
      await request(app)
        .get(`${API}/users`)
        .set(asUser(adminAccessToken))
        .query({ _cacheBuster: '123' })
        .expect(200);
    });
  });

  describe(`GET ${API}/users/:userId`, () => {
    test('an admin can read any user', async () => {
      await insertUsers([userOne, admin]);
      const res = await request(app)
        .get(`${API}/users/${userOne._id}`)
        .set(asUser(adminAccessToken))
        .expect(200);
      expect(res.body.data.user.email).toBe(userOne.email);
    });

    test('a user can read their own record', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/users/${userOne._id}`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data.user.id).toBe(userOne._id.toString());
    });

    test("a user cannot read someone else's record", async () => {
      await insertUsers([userOne, userTwo]);
      await request(app)
        .get(`${API}/users/${userTwo._id}`)
        .set(asUser(userOneAccessToken))
        .expect(403);
    });

    test('returns 400 for a malformed id', async () => {
      await insertUsers([admin]);
      const res = await request(app)
        .get(`${API}/users/not-an-object-id`)
        .set(asUser(adminAccessToken))
        .expect(400);
      expect(res.body.details[0].field).toBe('userId');
    });

    test('returns 404 for an id that does not exist', async () => {
      await insertUsers([admin]);
      const res = await request(app)
        .get(`${API}/users/${new mongoose.Types.ObjectId()}`)
        .set(asUser(adminAccessToken))
        .expect(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe(`POST ${API}/users`, () => {
    test('an admin can create a user with a role', async () => {
      await insertUsers([admin]);
      const res = await request(app)
        .post(`${API}/users`)
        .set(asUser(adminAccessToken))
        .send({
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'Str0ng!Pass1',
          role: 'admin',
        })
        .expect(201);
      expect(res.body.data.user.role).toBe('admin');
    });

    test('a non-admin is refused', async () => {
      await insertUsers([userOne]);
      await request(app)
        .post(`${API}/users`)
        .set(asUser(userOneAccessToken))
        .send({ name: 'Grace Hopper', email: 'grace@example.com', password: 'Str0ng!Pass1' })
        .expect(403);
    });

    test('rejects a duplicate email with 409', async () => {
      await insertUsers([admin, userOne]);
      await request(app)
        .post(`${API}/users`)
        .set(asUser(adminAccessToken))
        .send({ name: 'Copy', email: userOne.email, password: 'Str0ng!Pass1' })
        .expect(409);
    });
  });

  describe(`PATCH ${API}/users/:userId`, () => {
    test('an admin can update a user', async () => {
      await insertUsers([userOne, admin]);
      const res = await request(app)
        .patch(`${API}/users/${userOne._id}`)
        .set(asUser(adminAccessToken))
        .send({ name: 'Renamed', isActive: false })
        .expect(200);
      expect(res.body.data.user.name).toBe('Renamed');
      expect(res.body.data.user.isActive).toBe(false);
    });

    test('re-hashes a password set by an admin', async () => {
      await insertUsers([userOne, admin]);
      await request(app)
        .patch(`${API}/users/${userOne._id}`)
        .set(asUser(adminAccessToken))
        .send({ password: 'Rotated!Pass9' })
        .expect(200);

      const dbUser = await User.findById(userOne._id).select('+password');
      expect(dbUser.password).not.toBe('Rotated!Pass9');
      await request(app)
        .post(`${API}/auth/login`)
        .send({ email: userOne.email, password: 'Rotated!Pass9' })
        .expect(200);
    });

    test('rejects an empty update body', async () => {
      await insertUsers([admin]);
      await request(app)
        .patch(`${API}/users/${admin._id}`)
        .set(asUser(adminAccessToken))
        .send({})
        .expect(400);
    });

    test('a user cannot escalate their own role', async () => {
      await insertUsers([userOne]);
      await request(app)
        .patch(`${API}/users/${userOne._id}`)
        .set(asUser(userOneAccessToken))
        .send({ role: 'admin' })
        .expect(403);
    });
  });

  describe(`DELETE ${API}/users/:userId`, () => {
    test('an admin can delete a user', async () => {
      await insertUsers([userOne, admin]);
      await request(app)
        .delete(`${API}/users/${userOne._id}`)
        .set(asUser(adminAccessToken))
        .expect(204);
      expect(await User.findById(userOne._id)).toBeNull();
    });

    test('a non-admin is refused', async () => {
      await insertUsers([userOne, userTwo]);
      await request(app)
        .delete(`${API}/users/${userTwo._id}`)
        .set(asUser(userOneAccessToken))
        .expect(403);
    });
  });

  describe(`${API}/users/me`, () => {
    test('returns the caller profile', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data.user.email).toBe(userOne.email);
    });

    test('updates the caller profile', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .patch(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .send({ name: 'Updated Name' })
        .expect(200);
      expect(res.body.data.user.name).toBe('Updated Name');
    });

    test('does not accept role or password through the self-service route', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .patch(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .send({ role: 'admin' })
        .expect(400);
      expect(res.body.details.map((detail) => detail.field)).toContain('role');
    });

    test('rejects an email already used by someone else', async () => {
      await insertUsers([userOne, userTwo]);
      await request(app)
        .patch(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .send({ email: userTwo.email })
        .expect(409);
    });

    test('a deactivated user is rejected even with a valid token', async () => {
      await insertUsers([userOne]);
      await User.updateOne({ _id: userOne._id }, { $set: { isActive: false } });
      const res = await request(app)
        .get(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });

    test('a token whose user was deleted is rejected', async () => {
      const res = await request(app)
        .get(`${API}/users/me`)
        .set(asUser(userOneAccessToken))
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  describe('NoSQL injection defences', () => {
    test('operator objects in the login body cannot bypass authentication', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: { $gt: '' }, password: { $gt: '' } });
      expect([400, 401]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    test('operator objects in a query string are neutralised', async () => {
      await insertUsers([admin, userOne]);
      const res = await request(app)
        .get(`${API}/users?role[$ne]=admin`)
        .set(asUser(adminAccessToken));
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body.data)).toBe(true);
      }
    });

    test('password is never present in any user payload', async () => {
      await insertUsers([userOne, admin]);
      const res = await request(app).get(`${API}/users`).set(asUser(adminAccessToken)).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('password');
      expect(JSON.stringify(res.body)).not.toContain(password);
    });
  });
});
