'use strict';

/* eslint-disable no-console -- CLI script: stdout is the interface */

/**
 * Support lookup: "did this person pay?" (BACKEND_SPEC.md §6b rule 9).
 *
 *   npm run find-purchase -- pilgrim@example.com
 *
 * Prints the account id, its pass (granted or revoked, store, transaction id, dates),
 * the RevenueCat aliases linked to it, and its webhook events newest first. Never
 * prints a raw event body or any secret. An unknown email prints "no account".
 */

const mongoose = require('mongoose');

const when = (date) => (date ? new Date(date).toISOString() : '-');

/**
 * @param {string} email
 * @returns {Promise<string[]>} the report, one line per entry
 */
const findPurchase = async (email) => {
  // Loaded here, not at the top, so requiring this file for its tests reads no config.
  const { AliasLink, Entitlement, RevenueCatEvent, User } = require('../src/models');

  const address = String(email || '').trim().toLowerCase();
  const user = address ? await User.findOne({ email: address }).select('_id').lean() : null;
  if (!user) {
    return ['no account'];
  }

  const [entitlement, links] = await Promise.all([
    Entitlement.findOne({ user: user._id }).lean(),
    AliasLink.find({ user: user._id }).sort({ createdAt: 1 }).lean(),
  ]);
  const ids = [String(user._id), ...links.map((link) => link.alias)];
  const events = await RevenueCatEvent.find({
    $or: [{ appUserId: { $in: ids } }, { aliases: { $in: ids } }],
  })
    .select('-rawBody')
    .sort({ receivedAt: -1 })
    .lean();

  const lines = [`Account: ${user._id}`];

  if (entitlement) {
    lines.push(
      `Pass: ${entitlement.revokedAt ? 'REVOKED' : 'GRANTED'}`,
      `  entitlement id:  ${entitlement.entitlementId}`,
      `  store:           ${entitlement.store || '-'}`,
      `  transaction id:  ${entitlement.transactionId || '-'}`,
      `  granted at:      ${when(entitlement.grantedAt)}`,
      `  revoked at:      ${when(entitlement.revokedAt)}`
    );
  } else {
    lines.push('Pass: none');
  }

  lines.push(`Alias links (${links.length}):`);
  links.forEach((link) => lines.push(`  ${link.alias}`));

  lines.push(`Webhook events (${events.length}, newest first):`);
  events.forEach((event) =>
    lines.push(
      `  ${when(event.receivedAt)}  ${event.type}  ${event.environment || '-'}  ` +
        `processed: ${when(event.processedAt)}  error: ${event.processingError || '-'}  id: ${event._id}`
    )
  );
  return lines;
};

const main = async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run find-purchase -- <email>');
    process.exit(1);
  }
  const config = require('../src/config/config');
  await mongoose.connect(config.mongoose.url, { ...config.mongoose.options, autoIndex: false });
  try {
    (await findPurchase(email)).forEach((line) => console.log(line));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`find-purchase failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { findPurchase };
