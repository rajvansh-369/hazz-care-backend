'use strict';

const passwordService = require('../../src/services/password.service');

describe('password.service (argon2id)', () => {
  test('hash is argon2id with the configured cost parameters', async () => {
    const hash = await passwordService.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    const params = hash.split('$')[3].split(',').sort();
    expect(params).toEqual(['m=19456', 'p=1', 't=2']);
  });

  test('the right password verifies and a wrong one does not', async () => {
    const hash = await passwordService.hash('correct horse battery');
    await expect(passwordService.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(passwordService.verify(hash, 'correct horse batterY')).resolves.toBe(false);
  });

  test('a wrong password resolves false rather than throwing', async () => {
    const hash = await passwordService.hash('pilgrim-password');
    await expect(passwordService.verify(hash, '')).resolves.toBe(false);
  });

  test('does not truncate: passwords sharing an 80-byte prefix are different passwords', async () => {
    // bcrypt stops reading at 72 bytes, so on bcrypt both of these unlock the account.
    const p1 = `${'a'.repeat(80)}X`;
    const p2 = `${'a'.repeat(80)}Y`;
    const hash = await passwordService.hash(p1);
    await expect(passwordService.verify(hash, p1)).resolves.toBe(true);
    await expect(passwordService.verify(hash, p2)).resolves.toBe(false);
  });

  test('a 200-character passphrase round-trips (no maximum)', async () => {
    const passphrase = 'labbayk allahumma labbayk '.repeat(8).slice(0, 200);
    expect(passphrase).toHaveLength(200);
    const hash = await passwordService.hash(passphrase);
    await expect(passwordService.verify(hash, passphrase)).resolves.toBe(true);
    await expect(passwordService.verify(hash, passphrase.slice(0, 199))).resolves.toBe(false);
  });

  test('leading and trailing spaces are significant (never trimmed)', async () => {
    const hash = await passwordService.hash('  spaced out  ');
    await expect(passwordService.verify(hash, '  spaced out  ')).resolves.toBe(true);
    await expect(passwordService.verify(hash, 'spaced out')).resolves.toBe(false);
    await expect(passwordService.verify(hash, '  spaced out')).resolves.toBe(false);
    await expect(passwordService.verify(hash, 'spaced out  ')).resolves.toBe(false);
  });

  test('non-ASCII passwords round-trip (Arabic and Urdu script)', async () => {
    const arabic = 'لبيك اللهم لبيك';
    const urdu = 'میرا پاس ورڈ محفوظ ہے';
    const arabicHash = await passwordService.hash(arabic);
    const urduHash = await passwordService.hash(urdu);
    await expect(passwordService.verify(arabicHash, arabic)).resolves.toBe(true);
    await expect(passwordService.verify(urduHash, urdu)).resolves.toBe(true);
    await expect(passwordService.verify(arabicHash, urdu)).resolves.toBe(false);
  });

  test('the dummy hash is argon2id, computed once, and matches nothing', async () => {
    const dummy = await passwordService.getDummyHash();
    expect(dummy.startsWith('$argon2id$')).toBe(true);
    await expect(passwordService.getDummyHash()).resolves.toBe(dummy);
    await expect(passwordService.verify(dummy, 'password')).resolves.toBe(false);
    await expect(passwordService.verify(dummy, '')).resolves.toBe(false);
  });
});
