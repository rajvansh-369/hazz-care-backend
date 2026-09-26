'use strict';

/* eslint-disable no-console -- CLI script: stdout is the interface */

/**
 * HajjCare API — contract conformance check. Node port of scripts/verify-contract.sh.
 *
 * Run this GREEN before giving the Flutter developer a base URL. Every check here maps to a rule in
 * BACKEND_SPEC.md that the app breaks on. A failure is not a style issue: it is a pilgrim unable to
 * sign in, or signed out in Mina.
 *
 *   npm run contract                                   # http://localhost:<PORT from .env>/api/v1
 *   npm run contract -- https://api.hajjcare.example/api/v1
 *
 * No dependencies: Node's built-in fetch. Runs in PowerShell, cmd or any shell.
 *
 * Test addresses. Every run registers fresh accounts. By default they are @hajjcare.test, which
 * cannot receive mail: fine locally, where no email leaves the machine.
 *
 * Against a server that sends REAL email (staging), set OTP_EMAIL to a mailbox you can read. Every
 * address this run registers is then derived from it by plus-addressing,
 * `local+contract-<stamp>-<n>@domain`, so the reset email lands in that inbox and nothing is sent to
 * a domain that does not exist (bounces hurt the sender's reputation). Addresses that are never
 * registered (the unknown-address probes, which send nothing) stay on hajjcare.test.
 *
 * Section 13 needs the OTP from the reset email the run itself triggers:
 *   - localhost: read from the dev email directory (EMAIL_DEV_DIR), or, with MAILPIT_URL set, from
 *     Mailpit's HTTP API (the docker-compose stacks, real SMTP):
 *       MAILPIT_URL=http://localhost:8025 npm run contract -- http://localhost:5000/api/v1
 *   - a real host, with OTP_EMAIL set: the run pauses and asks for the code emailed to the address
 *     it prints. Read it from the inbox and type it in (blank skips section 13):
 *       OTP_EMAIL=you@gmail.com npm run contract -- https://api.example.com/api/v1
 *
 * Keep the sections, checks and messages in step with verify-contract.sh.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/** Minimal .env reader (KEY=VALUE lines) so this script needs no dependencies. */
const readDotEnv = () => {
  try {
    return fs
      .readFileSync(path.join(ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .reduce((acc, line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) {
          acc[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
        return acc;
      }, {});
  } catch (error) {
    return {};
  }
};

const dotEnv = readDotEnv();
// `key` is always a literal from this file, never input.
// eslint-disable-next-line security/detect-object-injection
const setting = (key, fallback) => process.env[key] || dotEnv[key] || fallback;

const BASE = (process.argv[2] || `http://localhost:${setting('PORT', '5000')}/api/v1`).replace(/\/+$/, '');
const BASE_HOST = (() => {
  try {
    return new URL(BASE).hostname;
  } catch (error) {
    console.error(`Not a valid base URL: ${BASE}`);
    process.exit(2);
    return '';
  }
})();
const IS_LOCAL = BASE_HOST === 'localhost' || BASE_HOST === '127.0.0.1';

const STAMP = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 32768)}`;

/** A real mailbox for the run's registered accounts (see the header), or empty. */
const OTP_EMAIL = (process.env.OTP_EMAIL || '').trim();
const OTP_MAILBOX = (() => {
  if (!OTP_EMAIL) {
    return null;
  }
  const at = OTP_EMAIL.lastIndexOf('@');
  if (at < 1 || at === OTP_EMAIL.length - 1 || /\s/.test(OTP_EMAIL)) {
    console.error(`OTP_EMAIL is not an email address: ${OTP_EMAIL}`);
    process.exit(2);
  }
  return { local: OTP_EMAIL.slice(0, at), domain: OTP_EMAIL.slice(at + 1) };
})();

let addressCount = 0;
/**
 * An address this run REGISTERS. With OTP_EMAIL: local+contract-<stamp>-<n>@domain, delivered to
 * that mailbox. Without: <label>+<stamp>@hajjcare.test.
 */
const registeredAddress = (label) => {
  addressCount += 1;
  return OTP_MAILBOX
    ? `${OTP_MAILBOX.local}+contract-${STAMP}-${addressCount}@${OTP_MAILBOX.domain}`
    : `${label}+${STAMP}@hajjcare.test`;
};
/** An address that is never registered: probes for unknown accounts, which send no email. */
const unknownAddress = (label) => `${label}+${STAMP}@hajjcare.test`;

const EMAIL = registeredAddress('contract');
// The same account in another case: the server must match addresses case-insensitively.
const EMAIL_UPPER = EMAIL.toUpperCase();
const PASSWORD = 'correct horse battery staple';
// The truncation probe: two passwords that share their first 72 bytes and differ after.
// bcrypt silently truncates at 72 bytes, so on a bcrypt server BOTH unlock the account.
const LONG_PREFIX = 'a'.repeat(80);
const LONG_PASSWORD = `${LONG_PREFIX}X`;
const LONG_PASSWORD_SAME_72 = `${LONG_PREFIX}Y`;

const REQUEST_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------------------------
// Output — plain ASCII markers, colour only on a TTY and never with NO_COLOR
// ---------------------------------------------------------------------------------------------

const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const bold = (t) => paint('1', t);

const sections = [];
let current = null;

const head = (title) => {
  current = { title, pass: 0, fail: 0, note: null };
  sections.push(current);
  console.log(`\n${bold(title)}`);
};
const ok = (message) => {
  current.pass += 1;
  console.log(`  ${green('[ok]  ')} ${message}`);
};
const bad = (message, got) => {
  current.fail += 1;
  console.log(`  ${red('[FAIL]')} ${message}`);
  if (got !== undefined && got !== '') {
    console.log(`         got: ${got}`);
  }
};
const note = (message) => {
  current.note = message;
  console.log(`  ${yellow('[skip]')} ${message}`);
};

// ---------------------------------------------------------------------------------------------
// HTTP and a small jq-alike over the last response
// ---------------------------------------------------------------------------------------------

let STATUS = '';
let BODY = '';
let JSON_BODY; // parsed body, or undefined when the body is empty or not JSON

/** req(method, path, rawJsonString?, bearer?) → sets STATUS, BODY, JSON_BODY. Like curl: '000' on no response. */
const req = async (method, urlPath, data, auth) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth) {
    headers.Authorization = `Bearer ${auth}`;
  }
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers,
      body: data ? data : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    STATUS = String(res.status);
    BODY = await res.text();
  } catch (error) {
    STATUS = '000';
    BODY = '';
  }
  try {
    JSON_BODY = BODY === '' ? undefined : JSON.parse(BODY);
  } catch (error) {
    JSON_BODY = undefined;
  }
};

const json = (value) => JSON.stringify(value);

const ERR = Symbol('jq error');
/** Walks a dotted path like jq: null stays null, indexing into a non-object is an error. */
const lookup = (dotted) => {
  if (JSON_BODY === undefined) {
    return ERR;
  }
  let value = JSON_BODY;
  for (const key of dotted.split('.').filter(Boolean)) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return ERR;
    }
    // eslint-disable-next-line security/detect-object-injection
    value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  }
  return value === undefined ? null : value;
};

/** jq's `type`, or '' when jq would have errored. */
const jtype = (dotted) => {
  const value = lookup(dotted);
  if (value === ERR) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
};

/** jq -r: strings raw, null as "null", others as JSON; '' when jq would have errored. */
const raw = (dotted) => {
  const value = lookup(dotted);
  if (value === ERR) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value === 'string' ? value : json(value);
};

/** A non-blank string at the path, or '' (jq: `.path // empty | strings`). */
const str = (dotted) => {
  const value = lookup(dotted);
  return typeof value === 'string' && value.trim() !== '' ? value : '';
};

/** jq `has(key)` on the root object: 'true'/'false', or '' when the root is not an object. */
const has = (...keys) => {
  if (JSON_BODY === null || typeof JSON_BODY !== 'object' || Array.isArray(JSON_BODY)) {
    return '';
  }
  return String(keys.some((key) => Object.prototype.hasOwnProperty.call(JSON_BODY, key)));
};

/** The `code` of every field error whose `field` matches (jq: `.errors[]? | select(.field==x) | .code`). */
const fieldCode = (field) => {
  const errors = lookup('errors');
  if (!Array.isArray(errors)) {
    return '';
  }
  return errors
    .filter((entry) => entry && entry.field === field)
    .map((entry) => (typeof entry.code === 'string' ? entry.code : json(entry.code)))
    .join('\n');
};

// ---------------------------------------------------------------------------------------------
// Section 13 helper — the OTP from the dev email directory (local hosts only)
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dev email file names: <unix-ms>-<4 hex>.json (the suffix keeps two emails written in
 * the same millisecond apart). The older <unix-ms>.json form is still accepted.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- one \d+ and a fixed-length optional group: linear
const DEV_EMAIL_FILE = /^(\d+)(?:-[0-9a-f]{4})?\.json$/;

/** Newest dev email in EMAIL_DEV_DIR addressed to `to`, waiting up to 5s. Never for a non-local host. */
const readDevEmailCode = async (to) => {
  if (!IS_LOCAL) {
    return null;
  }
  const dir = path.resolve(ROOT, setting('EMAIL_DEV_DIR', '.dev-emails'));
  const deadline = Date.now() + 5000;
  do {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => DEV_EMAIL_FILE.test(name));
    } catch (error) {
      files = [];
    }
    const sentAt = (name) => Number(DEV_EMAIL_FILE.exec(name)[1]);
    files.sort((a, b) => sentAt(b) - sentAt(a));
    for (const name of files) {
      try {
        const mail = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (mail && mail.to === to && typeof mail.code === 'string' && /^\d{6}$/.test(mail.code)) {
          return { code: mail.code, file: path.join(dir, name) };
        }
      } catch (error) {
        // A file still being written; try again on the next pass.
      }
    }
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
};

// ---------------------------------------------------------------------------------------------
// Section 13 helper — the OTP from Mailpit (local hosts only, and only with MAILPIT_URL set)
// ---------------------------------------------------------------------------------------------

const MAILPIT_URL = (process.env.MAILPIT_URL || '').replace(/\/+$/, '');

/** The code on its own line in the plain-text body (src/templates/otpEmail.js). */
const OTP_IN_TEXT = /^\s*(\d{6})\s*$/m;

/**
 * Newest message in Mailpit addressed to `to`, waiting up to 15s (the email is sent in the
 * background, with retries). This goes through the real SMTP provider, unlike the dev directory.
 * Never for a non-local host.
 */
const readMailpitCode = async (to) => {
  if (!IS_LOCAL || !MAILPIT_URL) {
    return null;
  }
  const query = encodeURIComponent(`to:"${to}"`);
  const deadline = Date.now() + 15000;
  do {
    try {
      const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=20`, {
        signal: AbortSignal.timeout(5000),
      });
      const { messages = [] } = search.ok ? await search.json() : {};
      const newest = messages
        .filter((m) => (m.To || []).some((r) => String(r.Address).toLowerCase() === to.toLowerCase()))
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
      if (newest) {
        const message = await fetch(`${MAILPIT_URL}/api/v1/message/${encodeURIComponent(newest.ID)}`, {
          signal: AbortSignal.timeout(5000),
        });
        const match = message.ok ? OTP_IN_TEXT.exec((await message.json()).Text || '') : null;
        if (match) {
          return { code: match[1], id: newest.ID };
        }
      }
    } catch (error) {
      // Mailpit not up yet, or the message still arriving; try again.
    }
    await sleep(500);
  } while (Date.now() < deadline);
  return null;
};

/**
 * Asks for the code emailed to `address` (a real host, OTP_EMAIL set). Empty when stdin is not a
 * terminal or nothing is entered.
 */
const promptForCode = async (address) => {
  if (!process.stdin.isTTY) {
    return '';
  }
  // eslint-disable-next-line global-require -- only needed on this path
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`  Enter the 6-digit code emailed to ${address} (blank to skip): `, resolve);
  });
  rl.close();
  return answer.trim();
};

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const run = async () => {
  console.log(bold(`HajjCare contract check → ${BASE}`));

  head(`1. Register — ${EMAIL}`);
  await req('POST', '/auth/register', json({ email: EMAIL, password: PASSWORD, fullName: 'Contract Test' }));
  if (STATUS === '200' || STATUS === '201') {ok(`register returns ${STATUS}`);}
  else {bad('register should be 200 or 201', `${STATUS} ${BODY}`);}
  if (has('data', 'success') === 'false') {ok('no data/success envelope');}
  else {bad('RULE 2: response is wrapped in an envelope', BODY);}
  if (jtype('user.id') === 'string') {ok('user.id is a JSON string');}
  else {bad('RULE 4: user.id must be a string', raw('user.id'));}
  if (str('user.id') !== '') {ok('user.id is non-blank');}
  else {bad('RULE 4: user.id is blank — the client refuses the session');}
  const EV = jtype('user.emailVerified');
  if (EV === 'boolean' || EV === 'null') {ok('emailVerified is a boolean (or absent)');}
  else {bad('RULE 3: emailVerified must be true/false, not 1 or "true"', EV);}
  const EX = jtype('tokens.expiresIn');
  if (EX === 'number' || EX === 'null') {ok('expiresIn is a number (or absent)');}
  else {bad('RULE 3: expiresIn must be a JSON number, not a string', EX);}
  if (jtype('tokens.accessToken') === 'string') {ok('accessToken present');}
  else {bad('accessToken missing or not a string');}
  if (jtype('tokens.refreshToken') === 'string') {ok('refreshToken present');}
  else {bad('refreshToken missing or not a string');}
  const ACCESS = raw('tokens.accessToken');
  const REFRESH = raw('tokens.refreshToken');
  const USER_ID = str('user.id');

  head('2. Register — duplicate, validation');
  await req('POST', '/auth/register', json({ email: EMAIL, password: PASSWORD, fullName: 'Dup' }));
  if (STATUS === '409') {ok('duplicate → 409');}
  else {bad('duplicate must be 409', STATUS);}
  if (raw('code') === 'email_taken') {ok('code = email_taken');}
  else {bad('code must be email_taken', raw('code'));}
  if (jtype('code') === 'string') {ok('error code is a string');}
  else {bad('RULE: error code must be a string');}

  await req('POST', '/auth/register', json({ email: registeredAddress('short'), password: '1234567', fullName: 'Short' }));
  if (STATUS === '422') {ok('7-char password → 422');}
  else {bad('short password must be 422', STATUS);}
  if (fieldCode('password') === 'password_too_short') {ok('field password = password_too_short');}
  else {bad('missing the password_too_short field error', BODY);}

  await req('POST', '/auth/register', json({ email: registeredAddress('eight'), password: '12345678', fullName: 'Eight' }));
  if (STATUS === '200' || STATUS === '201') {ok('8-char password accepted');}
  else {bad('8 chars is the floor, must be accepted', STATUS);}

  head('3. Passwords — no truncation, case-insensitive email');
  const LONGMAIL = registeredAddress('long');
  await req('POST', '/auth/register', json({ email: LONGMAIL, password: LONG_PASSWORD, fullName: 'Long' }));
  if (STATUS === '200' || STATUS === '201') {ok('81-char passphrase accepted');}
  else {bad('long passphrase rejected', STATUS);}
  await req('POST', '/auth/login', json({ email: LONGMAIL, password: LONG_PASSWORD }));
  if (STATUS === '200') {ok('long passphrase authenticates');}
  else {bad('long passphrase does not authenticate', STATUS);}
  await req('POST', '/auth/login', json({ email: LONGMAIL, password: LONG_PASSWORD_SAME_72 }));
  if (STATUS === '401' && raw('code') === 'invalid_credentials') {
    ok('a different password sharing the first 72 bytes → 401 invalid_credentials (no truncation)');
  } else {
    bad(
      'RULE: a different password sharing the first 72 bytes was not refused — the server truncates passwords (bcrypt?)',
      `${STATUS} ${BODY}`
    );
  }

  await req('POST', '/auth/login', json({ email: EMAIL_UPPER, password: PASSWORD }));
  if (STATUS === '200') {ok('email matched case-insensitively');}
  else {bad('server must lowercase email — the client does not', STATUS);}

  head('4. Login');
  await req('POST', '/auth/login', json({ email: EMAIL, password: PASSWORD }));
  if (STATUS === '200') {ok('login → 200');}
  else {bad('login failed', `${STATUS} ${BODY}`);}
  if (USER_ID !== '' && str('user.id') === USER_ID) {ok('user.id stable across register and login');}
  else {bad('RULE 4: user.id changed — local health data would be orphaned');}
  await req('POST', '/auth/login', json({ email: EMAIL, password: 'wrong password here' }));
  if (STATUS === '401') {ok('wrong password → 401');}
  else {bad('wrong password must be 401', STATUS);}
  if (raw('code') === 'invalid_credentials') {ok('code = invalid_credentials');}
  else {bad('code must be invalid_credentials', raw('code'));}
  await req('POST', '/auth/login', json({ email: unknownAddress('nobody'), password: 'whatever long' }));
  if (STATUS === '401') {ok('unknown email → 401 (no enumeration)');}
  else {bad('unknown email must be 401, never 404', STATUS);}

  head('5. Login and register must never 429 (RULE 10)');
  let L429 = false;
  for (let i = 1; i <= 20; i += 1) {
    await req('POST', '/auth/login', json({ email: EMAIL, password: 'still wrong pw' }));
    if (STATUS === '429') {
      L429 = true;
      break;
    }
  }
  if (!L429) {ok('20 failed logins, no 429');}
  else {bad('RULE 10: login returned 429 — wording is nonsense on a sign-in form');}
  let R429 = false;
  for (let i = 1; i <= 10; i += 1) {
    await req('POST', '/auth/register', json({ email: registeredAddress(`rl${i}`), password: PASSWORD, fullName: 'RL' }));
    if (STATUS === '429') {
      R429 = true;
      break;
    }
  }
  if (!R429) {ok('10 registers, no 429');}
  else {bad('RULE 10: register returned 429');}

  head('6. /auth/me');
  await req('GET', '/auth/me', '', ACCESS);
  if (STATUS === '200') {ok('me → 200');}
  else {bad('me failed', `${STATUS} ${BODY}`);}
  if (has('user') === 'false') {ok('bare AuthUser, not wrapped in {user:…}');}
  else {bad('me must return a bare user object', BODY);}
  if (USER_ID !== '' && str('id') === USER_ID) {ok('me returns the same id');}
  else {bad('id mismatch on /auth/me');}
  await req('GET', '/auth/me', '', 'definitely.not.a.valid.token');
  if (STATUS === '401') {ok('bad token → 401 (not 403)');}
  else {bad('RULE 6: expired/invalid token must be 401, never 403', STATUS);}

  head('7. Refresh — the only endpoint that can sign a pilgrim out');
  await req('POST', '/auth/refresh', json({ refreshToken: REFRESH }));
  if (STATUS === '200') {ok('refresh → 200');}
  else {bad('refresh failed', `${STATUS} ${BODY}`);}
  if (jtype('tokens.refreshToken') === 'string') {ok('refreshToken returned (required even without rotation)');}
  else {bad('refreshToken missing from refresh response');}
  const NEW_REFRESH = raw('tokens.refreshToken');
  await req('POST', '/auth/refresh', json({ refreshToken: REFRESH }));
  if (STATUS === '200') {ok('old token still works while its child is unused (or no rotation)');}
  else if (STATUS === '401') {bad('old token rejected before its child was used — a lost response or a refresh race will sign a pilgrim out');}
  else {bad('unexpected status reusing the old refresh token', STATUS);}
  await req('POST', '/auth/refresh', '{"refreshToken":"this-token-never-existed"}');
  if (STATUS === '401') {ok('unknown refresh token → 401 (a deliberate sign-out)');}
  else {bad('unknown refresh token should be 401', STATUS);}
  await req('POST', '/auth/refresh', '{}');
  if (STATUS !== '401' && STATUS !== '403') {ok(`malformed refresh body → ${STATUS}, not 401`);}
  else {bad(`RULE 5: a malformed body returned ${STATUS} — this signs pilgrims out. Use 400/503`);}
  await req('POST', '/auth/refresh', 'not json at all');
  if (STATUS !== '401' && STATUS !== '403') {ok(`unparseable refresh body → ${STATUS}, not 401`);}
  else {bad(`RULE 5: unparseable body returned ${STATUS} — signs pilgrims out`);}

  head('8. Forgot password — no enumeration');
  await req('POST', '/auth/forgot-password', json({ email: EMAIL }));
  const S1 = STATUS;
  const B1 = BODY;
  if (S1 === '200') {ok('known address → 200');}
  else {bad('forgot-password must be 200', S1);}
  if (raw('codeLength') === '6') {ok('codeLength = 6');}
  else {bad('codeLength must be 6 — the copy says so in 7 languages', raw('codeLength'));}
  if (jtype('codeLength') === 'number') {ok('codeLength is a number');}
  else {bad('RULE 3: codeLength must be a number, not a string');}
  if (jtype('expiresInSeconds') === 'number') {ok('expiresInSeconds is a number');}
  else {bad('expiresInSeconds must be a number');}
  if (jtype('resendAfterSeconds') === 'number') {ok('resendAfterSeconds is a number');}
  else {bad('resendAfterSeconds must be a number');}
  await req('POST', '/auth/forgot-password', json({ email: unknownAddress('ghost') }));
  if (STATUS === '200') {ok('unknown address → 200');}
  else {bad('unknown address must also be 200, never 404', STATUS);}
  if (BODY === B1) {ok('bodies are byte-identical for known and unknown');}
  else {bad('bodies differ — this is an account-enumeration oracle', `known=${B1} unknown=${BODY}`);}

  head('9. verify-otp');
  await req('POST', '/auth/verify-otp', json({ email: EMAIL, code: '000000' }));
  const WRONG_CODE = raw('code');
  if ((STATUS === '400' && WRONG_CODE === 'invalid_otp') || (STATUS === '429' && WRONG_CODE === 'too_many_attempts')) {
    ok(`wrong code → ${STATUS} ${WRONG_CODE}`);
  } else {
    bad('wrong code should be 400 invalid_otp (or 429 too_many_attempts if locked out)', `${STATUS} ${BODY}`);
  }
  if (STATUS !== '404') {ok('not 404');}
  else {bad('RULE 7: verify-otp must never 404');}
  await req('POST', '/auth/verify-otp', json({ email: unknownAddress('ghost'), code: '000000' }));
  if (raw('code') === 'invalid_otp') {ok('unknown address → invalid_otp, same as a wrong code');}
  else {bad('unknown address must answer invalid_otp, never account_not_found or 404', `${STATUS} ${BODY}`);}

  head('10. reset-password');
  await req('POST', '/auth/reset-password', '{"resetToken":"rst_never_issued","password":"a brand new password"}');
  if (STATUS === '400') {ok('bad reset token → 400');}
  else {bad('bad reset token should be 400', STATUS);}
  if (raw('code') === 'invalid_reset_token') {ok('code = invalid_reset_token');}
  else {bad('code must be invalid_reset_token', raw('code'));}
  await req('POST', '/auth/reset-password', '{"resetToken":"rst_never_issued","password":"short"}');
  if (STATUS === '422' || STATUS === '400') {ok(`short password on reset → ${STATUS}`);}
  else {bad('unexpected status', STATUS);}

  head('11. Logout — always 204, always idempotent');
  await req('POST', '/auth/logout', json({ refreshToken: NEW_REFRESH }));
  if (STATUS === '204') {ok('valid token → 204');}
  else {bad('logout must return 204', STATUS);}
  await req('POST', '/auth/logout', json({ refreshToken: NEW_REFRESH }));
  if (STATUS === '204') {ok('already-revoked token → 204 (idempotent)');}
  else {bad('logout must be idempotent', STATUS);}
  await req('POST', '/auth/logout', '{"refreshToken":""}');
  if (STATUS === '204') {ok('empty string token → 204');}
  else {bad('an empty refreshToken is normal — must be 204, not 400/422', STATUS);}
  await req('POST', '/auth/logout', '{"refreshToken":"unknown-token-value"}');
  if (STATUS === '204') {ok('unknown token → 204');}
  else {bad('unknown token must be 204', STATUS);}

  head('12. Status discipline under /auth (RULES 7, 8, 9)');
  for (const p of ['/auth/does-not-exist', '/auth/login/extra', '/auth/', '/auth/register/x']) {
    await req('POST', p, '{}');
    if (STATUS === '404') {bad(`RULE 7: ${p} returned 404 — renders as 'no account for that email'`);}
    else {ok(`${p} → ${STATUS} (not 404)`);}
  }
  for (const p of ['/auth/register', '/auth/forgot-password', '/auth/verify-otp', '/auth/reset-password']) {
    await req('POST', p, '{}');
    if (STATUS === '401' || STATUS === '403') {
      bad(`RULE 9: ${p} returned ${STATUS} — shows 'email and password do not match' on the wrong screen`);
    } else {
      ok(`${p} on empty body → ${STATUS} (not 401/403)`);
    }
    if (STATUS === '409') {bad(`RULE 8: ${p} returned 409 — renders as 'already has an account'`);}
  }

  head('13. [MANUAL] OTP flow');
  // The code section 8 sent to this run's own address. OTP_CODE in the environment wins.
  let OTP_CODE = process.env.OTP_CODE || '';
  if (OTP_CODE) {
    console.log(`  using OTP_CODE from the environment`);
  } else if (IS_LOCAL && MAILPIT_URL) {
    const found = await readMailpitCode(EMAIL);
    if (found) {
      OTP_CODE = found.code;
      console.log(`  using the code from Mailpit message ${found.id} (sent over real SMTP)`);
    }
  } else if (IS_LOCAL) {
    const found = await readDevEmailCode(EMAIL);
    if (found) {
      OTP_CODE = found.code;
      console.log(`  using the code from ${path.relative(ROOT, found.file)}`);
    }
  } else if (OTP_MAILBOX) {
    OTP_CODE = await promptForCode(EMAIL);
  }
  if (OTP_CODE) {
    await req('POST', '/auth/verify-otp', json({ email: EMAIL, code: OTP_CODE }));
    if (STATUS === '200') {ok('correct code → 200');}
    else {bad('correct code rejected', `${STATUS} ${BODY}`);}
    const RT = raw('resetToken');
    if (jtype('resetToken') === 'string') {ok('resetToken returned');}
    else {bad('resetToken missing');}
    if (has('tokens', 'accessToken', 'refreshToken') === 'false') {ok('no session issued by verify-otp');}
    else {bad('verify-otp must NOT return a session — that is a second way in');}
    await req('POST', '/auth/reset-password', json({ resetToken: RT, password: 'a fresh long password' }));
    if (STATUS === '204') {ok('reset → 204');}
    else {bad('reset should be 204', STATUS);}
    await req('POST', '/auth/reset-password', json({ resetToken: RT, password: 'another password' }));
    if (STATUS === '400') {ok('reset token is single-use');}
    else {bad('reset token reused successfully — single-use is firm', STATUS);}
    await req('POST', '/auth/login', json({ email: EMAIL, password: 'a fresh long password' }));
    if (STATUS === '200') {ok('new password works');}
    else {bad('new password does not authenticate', STATUS);}
  } else {
    note(
      IS_LOCAL && MAILPIT_URL
        ? `skipped — no OTP_CODE, and no email for ${EMAIL} appeared in Mailpit (${MAILPIT_URL}) within 15s`
        : IS_LOCAL
        ? `skipped — no OTP_CODE, and no dev email for ${EMAIL} appeared within 5s in ${setting('EMAIL_DEV_DIR', '.dev-emails')}`
        : OTP_MAILBOX
        ? `skipped — no code entered for ${EMAIL}`
        : `skipped — set OTP_EMAIL to a mailbox you can read and re-run; the run will ask for the code`
    );
  }

  // Summary
  const totalPass = sections.reduce((sum, s) => sum + s.pass, 0);
  const totalFail = sections.reduce((sum, s) => sum + s.fail, 0);
  console.log(`\n${bold('Summary')}`);
  const width = Math.max(...sections.map((s) => s.title.length));
  sections.forEach((s) => {
    const title = s.title.padEnd(width);
    const counts = s.note ? 'skipped' : `${String(s.pass).padStart(2)} passed  ${String(s.fail).padStart(2)} failed`;
    const colour = s.note ? yellow : s.fail ? red : green;
    console.log(`  ${colour(title)}  ${counts}`);
  });
  console.log(`\n${bold(`Passed: ${totalPass}   Failed: ${totalFail}`)}`);
  if (totalFail === 0) {
    console.log(green('Contract conformant. Safe to hand the base URL to the app developer.'));
  } else {
    console.log(red('Do NOT hand over the base URL yet.'));
  }
  return totalFail === 0 ? 0 : 1;
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Contract check crashed: ${error.stack || error.message}`);
    process.exit(1);
  });
