'use strict';

/**
 * The password-reset code email. ENGLISH ONLY for now: the app sends no locale
 * (BACKEND_SPEC.md §8 item 17, CLAUDE.md A10 rule t). Every word lives in this one
 * file, so localising later is one change here plus a locale from the client.
 *
 * Plain, inline-styled HTML: no images, no links, no tracking.
 *
 * @param {{ code: string, minutes: number }} params
 * @returns {{ subject: string, text: string, html: string }}
 */
const render = ({ code, minutes }) => {
  const subject = 'Your HajjCare password reset code';
  const expiry = `It expires in ${minutes} minutes.`;
  const ignore = 'If you did not ask to reset your password, you can ignore this email.';

  const text = [
    'Your HajjCare password reset code is:',
    '',
    `    ${code}`,
    '',
    expiry,
    '',
    ignore,
    '',
    'HajjCare',
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8"><title>' + subject + '</title></head>',
    '<body style="margin:0;padding:24px;background:#f6f6f4;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">',
    '<p style="margin:0 0 16px;font-size:16px;">Your HajjCare password reset code is:</p>',
    `<p style="margin:0 0 24px;font-size:36px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${code}</p>`,
    `<p style="margin:0 0 16px;font-size:16px;">${expiry}</p>`,
    `<p style="margin:0;font-size:14px;color:#52606d;">${ignore}</p>`,
    '</div>',
    '</body></html>',
  ].join('\n');

  return { subject, text, html };
};

module.exports = { render };
