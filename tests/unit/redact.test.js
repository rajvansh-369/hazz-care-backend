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

  test('redacts email and purchaseToken keys (CLAUDE.md C3)', () => {
    const out = redactInfo({ message: 'x', email: 'a@b.co', user: { Email: 'c@d.co', purchaseToken: 'p' } });
    expect(out.email).toBe(REDACTED);
    expect(out.user).toEqual({ Email: REDACTED, purchaseToken: REDACTED });
  });

  test('scrubs addresses, JWTs and reset tokens out of free text, including messages and stacks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const error = new Error('E11000 dup key: { email: "pilgrim@example.com" } rst_abc-DEF_123');
    const out = redactInfo({
      message: `login failed for Pilgrim@Example.com with Bearer ${jwt}`,
      err: error,
      list: ['to other@x.c please'],
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/pilgrim@example\.com/i);
    expect(text).not.toContain('other@x.c');
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('rst_abc');
    expect(out.message).toBe('login failed for [EMAIL] with Bearer [TOKEN]');
    expect(out.err.message).toBe('E11000 dup key: { email: "[EMAIL]" } [TOKEN]');
  });

  test.each(['developmentFormat', 'productionFormat'])(
    'the real logger (%s) keeps meta redacted: splat/errors must not restore it',
    (formatName) => {
      // Regression: splat() ran after redaction in the development format and
      // re-applied the original meta, so logger.x(msg, { password }) printed it.
      // eslint-disable-next-line global-require
      const { Writable } = require('stream');
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      const logger = require('../../src/config/logger');
      const lines = [];
      const capture = new winston.transports.Stream({
        stream: new Writable({
          write(chunk, encoding, callback) {
            lines.push(chunk.toString());
            callback();
          },
        }),
      });
      const previous = { format: logger.format, silent: logger.silent };
      logger.format = logger.formats[formatName];
      logger.silent = false;
      logger.add(capture);
      try {
        logger.error('failed for a@b.co', {
          password: 'hunter2-secret',
          email: 'c@d.co',
          nested: { refreshToken: 'rt-secret', note: 'mail e@f.co' },
          stack: 'Error: dup key { email: "g@h.co" }',
        });
        logger.error(new Error('boom for i@j.co'));
      } finally {
        logger.remove(capture);
        logger.format = previous.format;
        logger.silent = previous.silent;
      }
      const output = lines.join('');
      expect(lines).toHaveLength(2);
      ['hunter2-secret', 'rt-secret', 'a@b.co', 'c@d.co', 'e@f.co', 'g@h.co', 'i@j.co'].forEach(
        (secret) => expect(output).not.toContain(secret)
      );
      expect(output).toContain(REDACTED);
    }
  );

  test('leaves ordinary text alone', () => {
    const out = redactInfo({ message: 'POST /api/v1/auth/login 401 12.3 ms rid=abc-123' });
    expect(out.message).toBe('POST /api/v1/auth/login 401 12.3 ms rid=abc-123');
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
