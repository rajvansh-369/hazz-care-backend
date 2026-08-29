'use strict';

const http = require('http');
const request = require('supertest');
const gateway = require('../../src/gateway/gateway');
const { getService } = require('../../src/gateway/registry');
const config = require('../../src/config/config');
const { REQUEST_ID_HEADER } = require('../../src/config/constants');

const API = config.apiPrefix;
const UPSTREAM_PORT = Number(new URL(config.gateway.services.core).port);

/** Minimal stand-in for the core service, so the gateway is tested in isolation. */
const createUpstream = () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'from upstream', url: req.url }));
    });
  });
  return { server, received };
};

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

describe('API gateway', () => {
  beforeEach(() => {
    // Each test starts with a closed circuit.
    getService('core').breaker.recordSuccess();
  });

  describe('Gateway owned endpoints', () => {
    test('liveness answers even with every upstream down', async () => {
      const res = await request(gateway).get('/gateway/health').expect(200);
      expect(res.body.data.status).toBe('up');
      expect(res.body.data.service).toBe('api-gateway');
    });

    test('exposes the route table', async () => {
      const res = await request(gateway).get('/gateway/routes').expect(200);
      expect(res.body.data.routes[0]).toMatchObject({
        name: 'core',
        prefix: API,
        target: config.gateway.services.core,
      });
    });

    test('serves the end-to-end test console at the root', async () => {
      const res = await request(gateway).get('/').expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<!doctype html>');
    });

    test('unknown paths return a structured 404', async () => {
      const res = await request(gateway).get('/not-a-page').expect(404);
      expect(res.body.code).toBe('ROUTE_NOT_FOUND');
    });
  });

  describe('Proxying', () => {
    let upstream;

    beforeAll(async () => {
      upstream = createUpstream();
      await listen(upstream.server, UPSTREAM_PORT);
    });

    afterAll(async () => {
      await close(upstream.server);
    });

    beforeEach(() => {
      upstream.received.length = 0;
    });

    test('forwards the full path to the upstream unchanged', async () => {
      const res = await request(gateway).get(`${API}/tasks?limit=5`).expect(200);
      expect(res.body.message).toBe('from upstream');
      expect(upstream.received[0].url).toBe(`${API}/tasks?limit=5`);
    });

    test('propagates the correlation id and identifies itself', async () => {
      const id = 'gateway-correlation-id-0001';
      await request(gateway).get(`${API}/health`).set(REQUEST_ID_HEADER, id).expect(200);
      expect(upstream.received[0].headers[REQUEST_ID_HEADER]).toBe(id);
      expect(upstream.received[0].headers['x-gateway']).toBe('api-gateway');
    });

    test('forwards request bodies', async () => {
      await request(gateway)
        .post(`${API}/auth/login`)
        .send({ email: 'a@b.com', password: 'Str0ng!Pass1' })
        .expect(200);
      expect(JSON.parse(upstream.received[0].body)).toEqual({
        email: 'a@b.com',
        password: 'Str0ng!Pass1',
      });
    });

    test('adds the forwarding headers the service needs for client IPs', async () => {
      await request(gateway).get(`${API}/health`).expect(200);
      expect(upstream.received[0].headers['x-forwarded-for']).toBeDefined();
      expect(upstream.received[0].headers['x-forwarded-proto']).toBeDefined();
    });

    test('tags the response with the upstream that served it', async () => {
      const res = await request(gateway).get(`${API}/health`).expect(200);
      expect(res.headers['x-upstream-service']).toBe('core');
    });

    test('does not proxy paths outside the API prefix', async () => {
      await request(gateway).get('/gateway/health').expect(200);
      expect(upstream.received).toHaveLength(0);
    });
  });

  describe('Upstream failure handling', () => {
    test('returns 502 when the upstream is not listening', async () => {
      const res = await request(gateway).get(`${API}/health`).expect(502);
      expect(res.body).toMatchObject({ success: false, code: 'SERVICE_UNAVAILABLE' });
      expect(res.body.message).toContain('unreachable');
    });

    test('opens the circuit after repeated failures and then fails fast with 503', async () => {
      const { breaker } = getService('core');

      for (let attempt = 0; attempt < breaker.failureThreshold; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await request(gateway).get(`${API}/health`).expect(502);
      }

      expect(breaker.state).toBe('open');
      const res = await request(gateway).get(`${API}/health`).expect(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.message).toContain('temporarily unavailable');
    });

    test('a recovered upstream closes the circuit again', async () => {
      const { breaker } = getService('core');
      breaker.recordFailure();
      breaker.recordFailure();

      const upstream = createUpstream();
      await listen(upstream.server, UPSTREAM_PORT);
      try {
        await request(gateway).get(`${API}/health`).expect(200);
        expect(breaker.state).toBe('closed');
        expect(breaker.failures).toBe(0);
      } finally {
        await close(upstream.server);
      }
    });
  });
});
