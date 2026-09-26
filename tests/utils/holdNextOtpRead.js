'use strict';

const { PasswordResetOtp } = require('../../src/models');

/**
 * Pauses the NEXT otpService.verify() right after it has read the active code:
 * `read` resolves once that read has returned, and the verify carries on only after
 * `release()`. This is the interleaving a burst of parallel requests produces by
 * chance, made deterministic.
 *
 * It intercepts the next PasswordResetOtp.findOne() call, so start the verify (or the
 * POST /auth/verify-otp) it should hold immediately after calling this, before
 * anything else reads that collection. Relies on Jest's restoreMocks.
 *
 * @returns {{ read: Promise<void>, release: () => void }}
 */
const holdNextOtpRead = () => {
  const realFindOne = PasswordResetOtp.findOne.bind(PasswordResetOtp);
  let release;
  let signalRead;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const read = new Promise((resolve) => {
    signalRead = resolve;
  });
  jest.spyOn(PasswordResetOtp, 'findOne').mockImplementationOnce((...args) => ({
    sort: (...sortArgs) =>
      realFindOne(...args)
        .sort(...sortArgs)
        .then(async (doc) => {
          signalRead();
          await gate;
          return doc;
        }),
  }));
  return { read, release };
};

module.exports = holdNextOtpRead;
