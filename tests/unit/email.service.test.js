'use strict';

jest.mock('nodemailer', () => {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });
  return {
    createTransport: jest.fn(() => ({ sendMail })),
    __sendMail: sendMail,
  };
});

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');

const config = require('../../src/config/config');
const logger = require('../../src/config/logger');
const { createDevProvider, createSmtpProvider, createProvider } = require('../../src/lib/mail');
const { createEmailService, addressFingerprint } = require('../../src/services/email.service');
const otpEmail = require('../../src/templates/otpEmail');

const TO = 'Pilgrim@Example.com';
const CODE = '482913';

describe('email', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hajjcare-mail-'));
  });

  afterEach(async () => {
    jest.useRealTimers();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const filesIn = async (directory = dir) => {
    try {
      return (await fs.promises.readdir(directory)).sort();
    } catch (error) {
      return [];
    }
  };

  describe('template (English only)', () => {
    const rendered = otpEmail.render({ code: CODE, minutes: 10 });

    it('has the fixed subject', () => {
      expect(rendered.subject).toBe('Your HajjCare password reset code');
    });

    it('contains the code, "10 minutes" and the ignore line, in text and html', () => {
      [rendered.text, rendered.html].forEach((body) => {
        expect(body).toContain(CODE);
        expect(body).toContain('It expires in 10 minutes.');
        expect(body).toContain(
          'If you did not ask to reset your password, you can ignore this email.'
        );
      });
    });

    it('has no URLs, links, images or tracking', () => {
      const all = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
      expect(all).not.toMatch(/https?:|www\.|href=|src=|<img|<a\s/i);
    });

    it('derives minutes from OTP_TTL_SECONDS in the service', async () => {
      const send = jest.fn().mockResolvedValue({});
      const service = createEmailService({ provider: { send }, ttlSeconds: config.otp.ttlSeconds });
      service.enqueueOtpEmail({ to: TO, code: CODE });
      await service.idle();
      expect(send.mock.calls[0][0].text).toContain(
        `It expires in ${config.otp.ttlSeconds / 60} minutes.`
      );
    });
  });

  describe('dev provider', () => {
    it('refuses to run in production', () => {
      expect(() => createDevProvider({ dir, isProduction: true })).toThrow(/production/);
    });

    it('creates the directory if missing and writes the exact JSON shape', async () => {
      const nested = path.join(dir, 'a', 'b');
      const provider = createDevProvider({ dir: nested, isProduction: false });
      const message = otpEmail.render({ code: CODE, minutes: 10 });
      await provider.send({ to: TO, code: CODE, ...message });

      const files = await filesIn(nested);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d+-[0-9a-f]{4}\.json$/);

      const mail = JSON.parse(await fs.promises.readFile(path.join(nested, files[0]), 'utf8'));
      expect(Object.keys(mail).sort()).toEqual(['code', 'createdAt', 'subject', 'text', 'to']);
      expect(mail).toMatchObject({ to: TO, subject: message.subject, code: CODE, text: message.text });
      expect(new Date(mail.createdAt).toISOString()).toBe(mail.createdAt);
    });

    it('two emails in the same millisecond produce two files', async () => {
      jest.useFakeTimers({
        now: new Date('2026-09-24T12:00:00.000Z'),
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'queueMicrotask',
          'hrtime',
          'performance',
        ],
      });
      const provider = createDevProvider({ dir, isProduction: false });
      await Promise.all([
        provider.send({ to: 'a@x.com', subject: 's', text: 't', code: '111111' }),
        provider.send({ to: 'b@x.com', subject: 's', text: 't', code: '222222' }),
      ]);
      const files = await filesIn();
      expect(files).toHaveLength(2);
      expect(new Set(files.map((f) => f.split('-')[0])).size).toBe(1);
    });

    it('never overwrites: an identical random suffix is retried', async () => {
      jest.useFakeTimers({
        now: new Date('2026-09-24T12:00:00.000Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask', 'hrtime'],
      });
      jest
        .spyOn(crypto, 'randomBytes')
        .mockReturnValueOnce(Buffer.from('abcd', 'hex'))
        .mockReturnValueOnce(Buffer.from('abcd', 'hex'))
        .mockReturnValueOnce(Buffer.from('ef01', 'hex'));
      const provider = createDevProvider({ dir, isProduction: false });
      await provider.send({ to: 'a@x.com', subject: 's', text: 't', code: '111111' });
      await provider.send({ to: 'b@x.com', subject: 's', text: 't', code: '222222' });

      const files = await filesIn();
      expect(files).toEqual([`${Date.now()}-abcd.json`, `${Date.now()}-ef01.json`]);
    });
  });

  describe('smtp provider (nodemailer mocked, no network)', () => {
    it('sends with EMAIL_FROM, the recipient, subject, text and html', async () => {
      const provider = createSmtpProvider({
        url: 'smtp://user:pass@smtp.example.test:587',
        from: 'no-reply@hajjcare.test',
      });
      const message = otpEmail.render({ code: CODE, minutes: 10 });
      await provider.send({ to: TO, code: CODE, ...message });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        'smtp://user:pass@smtp.example.test:587'
      );
      expect(nodemailer.__sendMail).toHaveBeenCalledWith({
        from: 'no-reply@hajjcare.test',
        to: TO,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    });

    it('createProvider picks smtp when EMAIL_PROVIDER=smtp', () => {
      const provider = createProvider({
        provider: 'smtp',
        smtpUrl: 'smtp://localhost:1025',
        from: 'no-reply@hajjcare.test',
      });
      expect(provider.name).toBe('smtp');
    });

    it('createProvider picks dev otherwise', () => {
      expect(createProvider({ provider: 'dev', devDir: dir }).name).toBe('dev');
    });
  });

  describe('email.service', () => {
    it('enqueueOtpEmail returns before the dev file exists; the file appears shortly after', async () => {
      const service = createEmailService({
        provider: createDevProvider({ dir, isProduction: false }),
      });

      const returned = service.enqueueOtpEmail({ to: TO, code: CODE });
      expect(returned).toBeUndefined();
      expect(await filesIn()).toEqual([]);

      await service.idle();
      const files = await filesIn();
      expect(files).toHaveLength(1);
      const mail = JSON.parse(await fs.promises.readFile(path.join(dir, files[0]), 'utf8'));
      expect(Object.keys(mail).sort()).toEqual(['code', 'createdAt', 'subject', 'text', 'to']);
      expect(mail.to).toBe(TO);
      expect(mail.code).toBe(CODE);
      expect(mail.subject).toBe('Your HajjCare password reset code');
    });

    it('does not call the provider synchronously', () => {
      const send = jest.fn().mockResolvedValue({});
      const service = createEmailService({ provider: { send } });
      service.enqueueOtpEmail({ to: TO, code: CODE });
      expect(send).not.toHaveBeenCalled();
      return service.idle();
    });

    it('failing twice then succeeding → sent once, after delays 1s then 4s', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({});
      const sleep = jest.fn().mockResolvedValue(undefined);
      const log = jest.spyOn(logger, 'error');
      const service = createEmailService({ provider: { send }, sleep });

      service.enqueueOtpEmail({ to: TO, code: CODE });
      await service.idle();

      expect(send).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[1000], [4000]]);
      expect(log).not.toHaveBeenCalled();
    });

    it('failing three times → gives up; the log has neither the code nor the address', async () => {
      const failure = Object.assign(new Error(`550 mailbox ${TO} rejected, code ${CODE}`), {
        code: 'EENVELOPE',
        responseCode: 550,
      });
      const send = jest.fn().mockRejectedValue(failure);
      const sleep = jest.fn().mockResolvedValue(undefined);
      const log = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const service = createEmailService({ provider: { send }, sleep });

      service.enqueueOtpEmail({ to: TO, code: CODE });
      await service.idle();

      expect(send).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);

      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(CODE);
      expect(logged.toLowerCase()).not.toContain(TO.toLowerCase());
      expect(logged).not.toContain('pilgrim');
      expect(logged).toContain(addressFingerprint(TO));
      expect(log.mock.calls[0][1]).toMatchObject({ attempts: 3, errorCode: 'EENVELOPE', responseCode: 550 });
    });

    it('the address fingerprint is a short sha256 prefix, case-insensitive', () => {
      expect(addressFingerprint(TO)).toMatch(/^[0-9a-f]{12}$/);
      expect(addressFingerprint(TO)).toBe(addressFingerprint(' pilgrim@example.com '));
    });

    it('enqueueNoop sends nothing and writes no file', async () => {
      const send = jest.fn();
      const devService = createEmailService({
        provider: createDevProvider({ dir, isProduction: false }),
      });
      const spyService = createEmailService({ provider: { send } });
      const render = jest.spyOn(otpEmail, 'render');

      expect(devService.enqueueNoop()).toBeUndefined();
      spyService.enqueueNoop();
      await Promise.all([devService.idle(), spyService.idle()]);

      expect(send).not.toHaveBeenCalled();
      expect(await filesIn()).toEqual([]);
      expect(render).toHaveBeenCalledTimes(2);
    });

    it('several emails in flight are all delivered', async () => {
      const service = createEmailService({
        provider: createDevProvider({ dir, isProduction: false }),
      });
      for (let i = 0; i < 5; i += 1) {
        service.enqueueOtpEmail({ to: `p${i}@x.com`, code: String(100000 + i) });
      }
      await service.idle();
      expect(await filesIn()).toHaveLength(5);
    });
  });
});
