'use strict';

/**
 * Command line twin of the browser console: drives the same fifteen calls
 * against a running deployment and exits non-zero on the first mismatch.
 * Point it at any environment:
 *
 *   node src/scripts/smoke.js                       # http://localhost:8080
 *   node src/scripts/smoke.js https://api.example.com
 */
const config = require('../config/config');

const BASE = (process.argv[2] || `http://127.0.0.1:${config.gatewayPort}`).replace(/\/$/, '');
const API = `${BASE}${config.apiPrefix}`;

const session = {
  accessToken: null,
  refreshToken: null,
  user: null,
  taskId: null,
  spentRefresh: null,
};

const call = async (method, url, { body, token } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, body: { message: error.message }, ms: Date.now() - startedAt };
  }
};

const email = `smoke+${Date.now()}@example.com`;
const password = 'Str0ng!Pass1';

const steps = [
  {
    name: 'Gateway reaches the core service',
    run: () => call('GET', `${BASE}/gateway/health/services`),
    check: (r) => r.status === 200,
  },
  {
    name: 'Service is connected to MongoDB',
    run: () => call('GET', `${API}/health/ready`),
    check: (r) => r.status === 200 && r.body.data.dependencies.mongodb === 'up',
  },
  {
    name: 'Register issues a token pair',
    run: () =>
      call('POST', `${API}/auth/register`, { body: { name: 'Ada Lovelace', email, password } }),
    check: (r) => {
      if (r.status !== 201) {
        return false;
      }
      session.accessToken = r.body.data.tokens.access.token;
      session.refreshToken = r.body.data.tokens.refresh.token;
      session.user = r.body.data.user;
      return true;
    },
  },
  {
    name: 'Duplicate email is refused',
    run: () =>
      call('POST', `${API}/auth/register`, { body: { name: 'Ada Lovelace', email, password } }),
    check: (r) => r.status === 409 && r.body.code === 'EMAIL_ALREADY_EXISTS',
  },
  {
    name: 'Weak password is refused with field detail',
    run: () =>
      call('POST', `${API}/auth/register`, {
        body: { name: 'Weak', email: `weak+${Date.now()}@example.com`, password: 'password' },
      }),
    check: (r) => r.status === 400 && r.body.details.some((detail) => detail.field === 'password'),
  },
  {
    name: 'Login returns a fresh token pair',
    run: () => call('POST', `${API}/auth/login`, { body: { email, password } }),
    check: (r) => {
      if (r.status !== 200) {
        return false;
      }
      session.accessToken = r.body.data.tokens.access.token;
      session.refreshToken = r.body.data.tokens.refresh.token;
      return true;
    },
  },
  {
    name: 'Wrong password is refused',
    run: () => call('POST', `${API}/auth/login`, { body: { email, password: 'Wr0ng!Pass1' } }),
    check: (r) => r.status === 401 && r.body.code === 'INVALID_CREDENTIALS',
  },
  {
    name: 'Access token identifies the caller',
    run: () => call('GET', `${API}/auth/me`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.data.user.email === email,
  },
  {
    name: 'Missing token is refused',
    run: () => call('GET', `${API}/tasks`),
    check: (r) => r.status === 401 && r.body.code === 'UNAUTHENTICATED',
  },
  {
    name: 'Task is created and owned by the caller',
    run: () =>
      call('POST', `${API}/tasks`, {
        token: session.accessToken,
        body: { title: 'Verify the deployment', priority: 'high', tags: ['smoke'] },
      }),
    check: (r) => {
      if (r.status !== 201) {
        return false;
      }
      session.taskId = r.body.data.task.id;
      return r.body.data.task.owner === session.user.id;
    },
  },
  {
    name: 'List returns pagination metadata',
    run: () =>
      call('GET', `${API}/tasks?limit=5&sortBy=createdAt:desc`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.meta.totalResults >= 1,
  },
  {
    name: 'Closing a task stamps completion',
    run: () =>
      call('PATCH', `${API}/tasks/${session.taskId}`, {
        token: session.accessToken,
        body: { status: 'done' },
      }),
    check: (r) =>
      r.status === 200 && r.body.data.task.status === 'done' && !!r.body.data.task.completedAt,
  },
  {
    name: 'Counts are scoped to the caller',
    run: () => call('GET', `${API}/tasks/stats`, { token: session.accessToken }),
    check: (r) => r.status === 200 && r.body.data.done === 1,
  },
  {
    name: 'Refresh token rotates',
    run: async () => {
      session.spentRefresh = session.refreshToken;
      const result = await call('POST', `${API}/auth/refresh-tokens`, {
        body: { refreshToken: session.spentRefresh },
      });
      if (result.status === 200) {
        session.accessToken = result.body.data.tokens.access.token;
        session.refreshToken = result.body.data.tokens.refresh.token;
      }
      return result;
    },
    check: (r) => r.status === 200 && session.refreshToken !== session.spentRefresh,
  },
  {
    name: 'Spent refresh token cannot be replayed',
    run: () =>
      call('POST', `${API}/auth/refresh-tokens`, { body: { refreshToken: session.spentRefresh } }),
    check: (r) => r.status === 401 && r.body.code === 'TOKEN_INVALID',
  },
];

const main = async () => {
  console.log(`Smoke test against ${BASE}\n`);
  let passed = 0;

  for (const [index, step] of steps.entries()) {
    // Steps depend on each other, so they must run in order.
    // eslint-disable-next-line no-await-in-loop
    const result = await step.run();
    let ok = false;
    try {
      ok = step.check(result);
    } catch {
      ok = false;
    }
    const number = String(index + 1).padStart(2, '0');
    const verdict = ok ? 'pass' : 'FAIL';
    console.log(
      `${number}  ${verdict}  ${String(result.status).padStart(3)}  ${String(result.ms).padStart(5)}ms  ${step.name}`
    );
    if (ok) {
      passed += 1;
    } else {
      console.log(`      expected otherwise, got: ${JSON.stringify(result.body)}\n`);
    }
  }

  console.log(`\n${passed}/${steps.length} checks passed`);
  process.exit(passed === steps.length ? 0 : 1);
};

main();
