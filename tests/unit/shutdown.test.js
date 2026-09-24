'use strict';

const http = require('http');
const express = require('express');

const { createShutdown } = require('../../src/shutdown');

const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

/** Fakes that record the order in which shutdown touches each dependency. */
const recorder = ({ idle, disconnect } = {}) => {
  const calls = [];
  let exitResolve;
  const exited = new Promise((resolve) => {
    exitResolve = resolve;
  });
  const server = {
    close: jest.fn((callback) => {
      calls.push('server.close');
      setImmediate(() => {
        calls.push('server.closed');
        callback();
      });
    }),
    closeIdleConnections: jest.fn(),
  };
  const deps = {
    getServer: () => server,
    background: {
      idle: jest.fn(async () => {
        calls.push('background.idle');
        if (idle) {
          await idle();
        }
        calls.push('background.idle.done');
      }),
    },
    database: {
      disconnect: jest.fn(async () => {
        calls.push('db.disconnect');
        if (disconnect) {
          await disconnect();
        }
      }),
    },
    logger: silentLogger(),
    exit: jest.fn((code) => {
      calls.push(`exit:${code}`);
      exitResolve(code);
    }),
  };
  return { calls, server, deps, exited };
};

describe('graceful shutdown', () => {
  test('closes the server, then waits for background work, then closes MongoDB, then exits 0', async () => {
    const { calls, server, deps } = recorder();
    await createShutdown(deps)('SIGTERM');
    expect(calls).toEqual([
      'server.close',
      'server.closed',
      'background.idle',
      'background.idle.done',
      'db.disconnect',
      'exit:0',
    ]);
    expect(server.closeIdleConnections).toHaveBeenCalled();
  });

  test('passes a non-zero exit code through (uncaughtException)', async () => {
    const { calls, deps } = recorder();
    await createShutdown(deps)('uncaughtException', 1);
    expect(calls[calls.length - 1]).toBe('exit:1');
  });

  test('stops waiting for background work after the cap, then still closes MongoDB and exits 0', async () => {
    const { calls, deps } = recorder({ idle: () => new Promise(() => {}) });
    await createShutdown({ ...deps, backgroundIdleCapMs: 30 })('SIGTERM');
    expect(calls).toEqual(['server.close', 'server.closed', 'background.idle', 'db.disconnect', 'exit:0']);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/pending after 30ms/));
  });

  test('a failed background job does not stop the shutdown', async () => {
    const { calls, deps } = recorder({
      idle: async () => {
        throw new Error('smtp down');
      },
    });
    await createShutdown(deps)('SIGTERM');
    expect(calls.slice(-2)).toEqual(['db.disconnect', 'exit:0']);
  });

  test('a second signal exits 1 immediately, without waiting for the first', async () => {
    let releaseIdle;
    const { calls, deps } = recorder({
      idle: () =>
        new Promise((resolve) => {
          releaseIdle = resolve;
        }),
    });
    const shutdown = createShutdown(deps);
    const first = shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toContain('background.idle');

    await shutdown('SIGINT');
    expect(calls[calls.length - 1]).toBe('exit:1');
    expect(calls).not.toContain('db.disconnect');

    releaseIdle();
    await first;
  });

  test('an error while closing MongoDB exits 1', async () => {
    const { calls, deps } = recorder({
      disconnect: async () => {
        throw new Error('boom');
      },
    });
    await createShutdown(deps)('SIGTERM');
    expect(calls[calls.length - 1]).toBe('exit:1');
  });

  test('the backstop timer forces exit 1 when the server never closes', async () => {
    const { deps, server, exited } = recorder();
    server.close.mockImplementation(() => {});
    createShutdown({ ...deps, forceExitMs: 30 })('SIGTERM');
    await expect(exited).resolves.toBe(1);
    expect(deps.database.disconnect).not.toHaveBeenCalled();
  });

  test('a real server: an in-flight request completes, then the port refuses connections', async () => {
    const app = express();
    let requestStarted;
    const started = new Promise((resolve) => {
      requestStarted = resolve;
    });
    app.get('/slow', (req, res) => {
      requestStarted();
      setTimeout(() => res.json({ done: true }), 150);
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    // As in src/index.js: a keep-alive socket must not hold shutdown open this long.
    server.keepAliveTimeout = 65000;
    const { port } = server.address();
    const began = Date.now();
    const order = [];

    const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => {
      order.push('response');
      return { status: res.status, body: await res.json() };
    });
    await started;

    let exitResolve;
    const exited = new Promise((resolve) => {
      exitResolve = resolve;
    });
    createShutdown({
      getServer: () => server,
      background: { idle: async () => order.push('background.idle') },
      database: { disconnect: async () => order.push('db.disconnect') },
      logger: silentLogger(),
      exit: (code) => {
        order.push(`exit:${code}`);
        exitResolve(code);
      },
    })('SIGTERM');

    await expect(inFlight).resolves.toEqual({ status: 200, body: { done: true } });
    await exited;
    expect(order).toEqual(['response', 'background.idle', 'db.disconnect', 'exit:0']);
    // Regression: the kept-alive socket of the finished request held close() open.
    expect(Date.now() - began).toBeLessThan(1500);

    await expect(
      new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/slow`, resolve).on('error', reject);
      })
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
