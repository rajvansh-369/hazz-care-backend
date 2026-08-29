'use strict';

const request = require('supertest');
const app = require('../../src/app');
const setupTestDB = require('../utils/setupTestDB');
const config = require('../../src/config/config');
const { REQUEST_ID_HEADER } = require('../../src/config/constants');

setupTestDB();

const API = config.apiPrefix;

describe('Application wiring', () => {
  describe('Health probes', () => {
    test('liveness answers at the root path', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.data.status).toBe('up');
    });

    test('liveness answers under the API prefix', async () => {
      const res = await request(app).get(`${API}/health`).expect(200);
      expect(res.body.success).toBe(true);
    });

    test('readiness reports the database as connected', async () => {
      const res = await request(app).get(`${API}/health/ready`).expect(200);
      expect(res.body.data.status).toBe('ready');
      expect(res.body.data.dependencies.mongodb).toBe('up');
    });
  });

  describe('Correlation id', () => {
    test('generates one when the client does not send it', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    });

    test('echoes a well formed client supplied id', async () => {
      const id = 'client-supplied-request-id-1234';
      const res = await request(app).get('/health').set(REQUEST_ID_HEADER, id).expect(200);
      expect(res.headers[REQUEST_ID_HEADER]).toBe(id);
    });

    test('replaces a malformed client supplied id', async () => {
      const res = await request(app).get('/health').set(REQUEST_ID_HEADER, 'nope!').expect(200);
      expect(res.headers[REQUEST_ID_HEADER]).not.toBe('nope!');
    });

    test('includes the id in error payloads', async () => {
      const res = await request(app).get(`${API}/does-not-exist`).expect(404);
      expect(res.body.requestId).toBe(res.headers[REQUEST_ID_HEADER]);
    });
  });

  describe('Security headers', () => {
    test('sets the expected hardening headers and hides the framework', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    test('unknown routes return a structured 404', async () => {
      const res = await request(app).get('/no/such/path').expect(404);
      expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
      expect(res.body.message).toContain('/no/such/path');
    });

    test('malformed JSON returns 400 rather than a stack trace', async () => {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .set('Content-Type', 'application/json')
        .send('{"email": "a@b.com",}')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toBe('Request body is not valid JSON');
    });

    test('an oversized body returns 413', async () => {
      const res = await request(app)
        .post(`${API}/auth/login`)
        .send({ email: 'a@b.com', password: 'x'.repeat(200 * 1024) })
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('an unsupported method on a known path returns 404', async () => {
      await request(app).put(`${API}/auth/login`).send({}).expect(404);
    });
  });

  describe('CORS', () => {
    test('reflects the requesting origin and allows credentials', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    test('answers preflight requests', async () => {
      const res = await request(app)
        .options(`${API}/auth/login`)
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('API documentation', () => {
    test('serves the OpenAPI document outside production', async () => {
      const res = await request(app).get(`${API}/docs/openapi.json`).expect(200);
      expect(res.body.openapi).toBe('3.0.3');
      expect(Object.keys(res.body.paths).length).toBeGreaterThan(5);
    });
  });
});
