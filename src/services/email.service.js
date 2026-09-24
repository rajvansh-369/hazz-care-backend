'use strict';

const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../config/logger');
const { createProvider } = require('../lib/mail');
const otpEmail = require('../templates/otpEmail');

const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];
const DUMMY_CODE = '000000';

const minutesFromSeconds = (seconds) => Math.round(seconds / 60);

/** Enough to correlate log lines for one address; never the address itself. */
const addressFingerprint = (to) =>
  crypto.createHash('sha256').update(String(to).trim().toLowerCase()).digest('hex').slice(0, 12);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outbound email, always off the request path (CLAUDE.md C1, A10 rule m).
 *
 * The enqueue functions return immediately and do their work on setImmediate, so
 * forgot-password answers in the same time whether or not an account exists and
 * never waits on SMTP. A send is retried up to 3 attempts (delays 1s, then 4s).
 * Pending sends are lost on a restart; that is accepted — the pilgrim taps Resend.
 *
 * @param {{
 *   provider?: { send: Function },
 *   retryDelaysMs?: number[],
 *   sleep?: (ms: number) => Promise<void>,
 *   ttlSeconds?: number,
 * }} [deps]
 */
const createEmailService = ({
  provider,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = defaultSleep,
  ttlSeconds = config.otp.ttlSeconds,
} = {}) => {
  let resolvedProvider = provider || null;
  const getProvider = () => {
    if (!resolvedProvider) {
      resolvedProvider = createProvider();
    }
    return resolvedProvider;
  };

  const pending = new Set();

  /** Runs `job` on the next turn of the event loop and tracks it until it settles. */
  const schedule = (job) => {
    const done = new Promise((resolve) => {
      setImmediate(() => {
        Promise.resolve()
          .then(job)
          .catch((error) => {
            logger.error('Email job failed unexpectedly', { errorName: error && error.name });
          })
          .finally(resolve);
      });
    });
    pending.add(done);
    done.finally(() => pending.delete(done));
  };

  const deliverOtp = async ({ to, code }) => {
    const message = otpEmail.render({ code, minutes: minutesFromSeconds(ttlSeconds) });
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await getProvider().send({ to, code, ...message });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1]);
        }
      }
    }
    // Never the code, never the address in clear, never the provider's message
    // (an SMTP rejection usually quotes the recipient).
    logger.error('Password reset email not delivered after retries', {
      attempts: MAX_ATTEMPTS,
      to: addressFingerprint(to),
      errorName: lastError && lastError.name,
      errorCode: lastError && lastError.code !== undefined ? String(lastError.code) : undefined,
      responseCode: lastError && lastError.responseCode,
    });
  };

  /**
   * Returns immediately; the email is sent in the background.
   * @param {{ to: string, code: string }} message
   */
  const enqueueOtpEmail = ({ to, code }) => {
    schedule(() => deliverOtp({ to, code }));
  };

  /**
   * The unknown-address path of forgot-password: returns immediately and does
   * comparable scheduled work (renders the template) but sends nothing.
   */
  const enqueueNoop = () => {
    schedule(() => {
      otpEmail.render({ code: DUMMY_CODE, minutes: minutesFromSeconds(ttlSeconds) });
    });
  };

  /** Resolves when every scheduled job has settled. For tests and graceful shutdown. */
  const idle = async () => {
    while (pending.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...pending]);
    }
  };

  return { enqueueOtpEmail, enqueueNoop, idle };
};

module.exports = {
  ...createEmailService(),
  createEmailService,
  addressFingerprint,
};
