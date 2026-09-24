'use strict';

const { redactInfo, REDACTED } = require('../../src/config/redact');

describe('log redaction', () => {
  test('redacts secret keys at any depth, case-insensitively, and keeps everything else', () => {
    const info = {
      level: 'info',
      message: 'hello',
      requestId: 'rid-1',
      password: 'correct horse',
      nested: {
        refreshToken: 'r',
        AccessToken: 'a',
        list: [{ resetToken: 't', code: '123456', keep: 1 }],
        headers: { Authorization: 'Bearer x', accept: 'application/json' },
      },
    };

    const out = redactInfo(info);

    expect(out).toBe(info);
    expect(out.requestId).toBe('rid-1');
    expect(out.password).toBe(REDACTED);
    expect(out.nested.refreshToken).toBe(REDACTED);
    expect(out.nested.AccessToken).toBe(REDACTED);
    expect(out.nested.list[0]).toEqual({ resetToken: REDACTED, code: REDACTED, keep: 1 });
    expect(out.nested.headers).toEqual({ Authorization: REDACTED, accept: 'application/json' });
  });

  test('keeps winston symbol keys and survives circular references', () => {
    const level = Symbol.for('level');
    const info = { message: 'x', [level]: 'info', meta: {} };
    info.meta.self = info.meta;

    const out = redactInfo(info);

    expect(out[level]).toBe('info');
    expect(out.meta.self).toBe('[Circular]');
  });

  test('redacts inside Error objects without losing message or stack', () => {
    const error = new Error('boom');
    error.password = 'secret';
    const out = redactInfo({ message: 'failed', err: error });
    expect(out.err.message).toBe('boom');
    expect(out.err.stack).toEqual(expect.any(String));
    expect(out.err.password).toBe(REDACTED);
  });
});
