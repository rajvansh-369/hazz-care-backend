'use strict';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const setupTestDB = require('../utils/setupTestDB');
const { Task } = require('../../src/models');
const config = require('../../src/config/config');
const { userOne, userTwo, admin, insertUsers } = require('../fixtures/user.fixture');
const {
  userOneAccessToken,
  userTwoAccessToken,
  adminAccessToken,
} = require('../fixtures/token.fixture');
const { taskOne, taskTwo, insertTasks } = require('../fixtures/task.fixture');

setupTestDB();

const API = config.apiPrefix;
const asUser = (token) => ({ Authorization: `Bearer ${token}` });

describe('Task routes', () => {
  describe(`POST ${API}/tasks`, () => {
    test('creates a task owned by the caller', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/tasks`)
        .set(asUser(userOneAccessToken))
        .send({ title: 'Ship the release', priority: 'high', tags: ['release'] })
        .expect(201);

      expect(res.body.data.task).toMatchObject({
        title: 'Ship the release',
        status: 'todo',
        priority: 'high',
        tags: ['release'],
        owner: userOne._id.toString(),
      });

      const dbTask = await Task.findById(res.body.data.task.id);
      expect(dbTask.owner.toString()).toBe(userOne._id.toString());
    });

    test('ignores an owner supplied by the client', async () => {
      await insertUsers([userOne, userTwo]);
      const res = await request(app)
        .post(`${API}/tasks`)
        .set(asUser(userOneAccessToken))
        .send({ title: 'Try to plant a task', owner: userTwo._id.toString() })
        .expect(400);
      expect(res.body.details.map((detail) => detail.field)).toContain('owner');
    });

    test.each([
      ['missing title', {}, 'title'],
      ['short title', { title: 'ab' }, 'title'],
      ['unknown status', { title: 'Valid title', status: 'archived' }, 'status'],
      ['unknown priority', { title: 'Valid title', priority: 'urgent' }, 'priority'],
      [
        'too many tags',
        { title: 'Valid title', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
        'tags',
      ],
      ['invalid due date', { title: 'Valid title', dueDate: 'yesterday' }, 'dueDate'],
    ])('rejects %s', async (_label, body, field) => {
      await insertUsers([userOne]);
      const res = await request(app)
        .post(`${API}/tasks`)
        .set(asUser(userOneAccessToken))
        .send(body)
        .expect(400);
      expect(res.body.details.map((detail) => detail.field)).toContain(field);
    });

    test('requires authentication', async () => {
      await request(app).post(`${API}/tasks`).send({ title: 'No token here' }).expect(401);
    });
  });

  describe(`GET ${API}/tasks`, () => {
    test('returns only the tasks owned by the caller', async () => {
      await insertUsers([userOne, userTwo]);
      await insertTasks([taskOne(userOne._id), taskTwo(userTwo._id)]);

      const res = await request(app)
        .get(`${API}/tasks`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].owner).toBe(userOne._id.toString());
    });

    test('an admin sees every task', async () => {
      await insertUsers([userOne, userTwo, admin]);
      await insertTasks([taskOne(userOne._id), taskTwo(userTwo._id)]);

      const res = await request(app).get(`${API}/tasks`).set(asUser(adminAccessToken)).expect(200);
      expect(res.body.meta.totalResults).toBe(2);
    });

    test('a client cannot widen its scope by sending an owner filter', async () => {
      await insertUsers([userOne, userTwo]);
      await insertTasks([taskOne(userOne._id), taskTwo(userTwo._id)]);

      const res = await request(app)
        .get(`${API}/tasks`)
        .query({ owner: userTwo._id.toString() })
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data.every((task) => task.owner === userOne._id.toString())).toBe(true);
    });

    test('filters by status and priority', async () => {
      await insertUsers([userOne]);
      await insertTasks([taskOne(userOne._id), taskTwo(userOne._id)]);

      const res = await request(app)
        .get(`${API}/tasks`)
        .query({ status: 'in_progress' })
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('in_progress');
    });

    test('searches by title prefix', async () => {
      await insertUsers([userOne]);
      await insertTasks([taskOne(userOne._id), taskTwo(userOne._id)]);

      const res = await request(app)
        .get(`${API}/tasks`)
        .query({ title: 'write' })
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Write the integration tests');
    });

    test('paginates', async () => {
      await insertUsers([userOne]);
      await insertTasks(
        Array.from({ length: 12 }, (_, index) => ({
          _id: new mongoose.Types.ObjectId(),
          title: `Generated task number ${index}`,
          owner: userOne._id,
        }))
      );

      const res = await request(app)
        .get(`${API}/tasks`)
        .query({ page: 2, limit: 5 })
        .set(asUser(userOneAccessToken))
        .expect(200);

      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta).toEqual({ page: 2, limit: 5, totalPages: 3, totalResults: 12 });
    });

    test('caps the page size at 100', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/tasks`)
        .query({ limit: 5000 })
        .set(asUser(userOneAccessToken))
        .expect(400);
      expect(res.body.details[0].field).toBe('limit');
    });
  });

  describe(`GET ${API}/tasks/:taskId`, () => {
    test('reads an owned task', async () => {
      await insertUsers([userOne]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      const res = await request(app)
        .get(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data.task.id).toBe(task._id.toString());
    });

    test("returns 404 (not 403) for another user's task, so ids cannot be probed", async () => {
      await insertUsers([userOne, userTwo]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      const res = await request(app)
        .get(`${API}/tasks/${task._id}`)
        .set(asUser(userTwoAccessToken))
        .expect(404);
      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('returns 400 for a malformed id', async () => {
      await insertUsers([userOne]);
      await request(app).get(`${API}/tasks/123`).set(asUser(userOneAccessToken)).expect(400);
    });
  });

  describe(`PATCH ${API}/tasks/:taskId`, () => {
    test('updates an owned task and stamps completion', async () => {
      await insertUsers([userOne]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      const res = await request(app)
        .patch(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .send({ status: 'done' })
        .expect(200);

      expect(res.body.data.task.status).toBe('done');
      expect(res.body.data.task.completedAt).toEqual(expect.any(String));
    });

    test('clears completion when a task is reopened', async () => {
      await insertUsers([userOne]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      await request(app)
        .patch(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .send({ status: 'done' })
        .expect(200);
      const res = await request(app)
        .patch(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .send({ status: 'todo' })
        .expect(200);
      expect(res.body.data.task.completedAt).toBeNull();
    });

    test("cannot update another user's task", async () => {
      await insertUsers([userOne, userTwo]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      await request(app)
        .patch(`${API}/tasks/${task._id}`)
        .set(asUser(userTwoAccessToken))
        .send({ title: 'Hijacked title' })
        .expect(404);
    });

    test('rejects an empty body', async () => {
      await insertUsers([userOne]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);
      await request(app)
        .patch(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .send({})
        .expect(400);
    });
  });

  describe(`DELETE ${API}/tasks/:taskId`, () => {
    test('deletes an owned task', async () => {
      await insertUsers([userOne]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      await request(app)
        .delete(`${API}/tasks/${task._id}`)
        .set(asUser(userOneAccessToken))
        .expect(204);
      expect(await Task.findById(task._id)).toBeNull();
    });

    test("cannot delete another user's task", async () => {
      await insertUsers([userOne, userTwo]);
      const task = taskOne(userOne._id);
      await insertTasks([task]);

      await request(app)
        .delete(`${API}/tasks/${task._id}`)
        .set(asUser(userTwoAccessToken))
        .expect(404);
      expect(await Task.findById(task._id)).not.toBeNull();
    });
  });

  describe(`GET ${API}/tasks/stats`, () => {
    test('counts the caller tasks by status', async () => {
      await insertUsers([userOne, userTwo]);
      await insertTasks([taskOne(userOne._id), taskTwo(userOne._id), taskOne(userTwo._id)]);

      const res = await request(app)
        .get(`${API}/tasks/stats`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.data).toEqual({ total: 2, todo: 1, in_progress: 1, done: 0 });
    });

    test('is not shadowed by the :taskId route', async () => {
      await insertUsers([userOne]);
      const res = await request(app)
        .get(`${API}/tasks/stats`)
        .set(asUser(userOneAccessToken))
        .expect(200);
      expect(res.body.message).toBe('Task statistics');
    });
  });
});
