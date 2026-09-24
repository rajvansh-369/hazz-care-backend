'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../config/logger');
const { AliasLink, Entitlement, RevenueCatEvent, User } = require('../models');

/**
 * RevenueCat webhook events (BACKEND_SPEC.md §6b, CLAUDE.md A5).
 *
 * `store` runs on the request path and does one thing: persist the raw event, keyed on
 * `event.id` so a redelivery is a duplicate key. Everything else runs after the 200,
 * in `processEvent`, which never throws: a failure is recorded on the event.
 *
 * Nothing here gates a pilgrim's access (the app decides from its own database). The
 * Entitlement record exists so support can answer "did this person pay" and so a refund
 * has somewhere to land. The pass is lifetime: no expiry is read, stored or swept.
 */

const DUPLICATE_KEY = 11000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UNRESOLVED = 'unresolved';
const REFUND_REASON = 'CUSTOMER_SUPPORT';
/** Reconciliation re-processes older events, which may reconcile others in turn. */
const MAX_RECONCILE_DEPTH = 3;

const strings = (...values) =>
  values.flat().filter((value) => typeof value === 'string' && value.length > 0);
const unique = (values) => [...new Set(values)];
const stringOrNull = (value) => (typeof value === 'string' && value ? value : null);
const dateFromMs = (ms, fallback) => (Number.isFinite(ms) ? new Date(ms) : fallback);

/**
 * The event object of a webhook body, or null when the body is not JSON or has no
 * string `event.id`. Keys are RevenueCat's snake_case, read as they arrive (§7.1).
 */
const parseEvent = (rawBody) => {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    return null;
  }
  const event = body && typeof body === 'object' ? body.event : null;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return null;
  }
  return typeof event.id === 'string' && event.id.length > 0 ? event : null;
};

const isDuplicateKey = (error) => Boolean(error) && error.code === DUPLICATE_KEY;

/** Runs `fn` again once after a duplicate-key race on an upsert. */
const retryOnDuplicate = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }
    return fn();
  }
};

const createRevenueCatService = ({ now = () => new Date() } = {}) => {
  const pending = new Set();
  const entitlementId = () => config.revenueCat.entitlementId;

  /**
   * Persists the event exactly as received. Resolves 'stored' or 'duplicate' (a
   * redelivery, already stored); throws on a storage failure so the caller answers 503
   * and RevenueCat retries.
   */
  const store = async (event, rawBody) => {
    try {
      await RevenueCatEvent.create({
        _id: event.id,
        type: stringOrNull(event.type) || '(missing)',
        appUserId:
          strings(
            event.app_user_id,
            event.original_app_user_id,
            Array.isArray(event.transferred_to) ? event.transferred_to : [],
            Array.isArray(event.transferred_from) ? event.transferred_from : []
          )[0] || null,
        aliases: unique(strings(Array.isArray(event.aliases) ? event.aliases : [])),
        environment: stringOrNull(event.environment),
        entitlementIds: strings(Array.isArray(event.entitlement_ids) ? event.entitlement_ids : []),
        rawBody,
        receivedAt: now(),
      });
      return 'stored';
    } catch (error) {
      if (isDuplicateKey(error)) {
        return 'duplicate';
      }
      throw error;
    }
  };

  // -------------------------------------------------------------------------------------
  // Resolving RevenueCat App User IDs to our accounts
  // -------------------------------------------------------------------------------------

  /**
   * Every candidate that is an existing account's id, plus every alias already linked
   * to an account, in candidate order. Returns the resolved account ids and the
   * candidates that are not account ids (the aliases to link).
   */
  const resolve = async (candidates) => {
    const idCandidates = candidates.filter((c) => OBJECT_ID.test(c)).map((c) => c.toLowerCase());
    const existing = idCandidates.length
      ? await User.find({ _id: { $in: idCandidates } }).select('_id').lean()
      : [];
    const accountIds = new Set(existing.map((user) => String(user._id)));
    const aliases = candidates.filter((c) => !accountIds.has(c.toLowerCase()));
    const links = aliases.length
      ? await AliasLink.find({ alias: { $in: aliases }, user: { $ne: null } }).lean()
      : [];
    const linkedTo = new Map(links.map((link) => [link.alias, String(link.user)]));

    const resolved = unique(
      candidates
        .map((c) => (accountIds.has(c.toLowerCase()) ? c.toLowerCase() : linkedTo.get(c)))
        .filter(Boolean)
    );
    return { userIds: resolved, aliases };
  };

  /**
   * Records alias → account. A new alias gets `userId` (or null when unresolved); an
   * alias still pointing at null is claimed; an alias already linked is never moved.
   */
  const linkAliases = async (aliases, userId) => {
    for (const alias of aliases) {
      // eslint-disable-next-line no-await-in-loop
      await retryOnDuplicate(() =>
        AliasLink.updateOne({ alias }, { $setOnInsert: { user: userId } }, { upsert: true })
      );
      if (userId) {
        // eslint-disable-next-line no-await-in-loop
        await AliasLink.updateOne({ alias, user: null }, { $set: { user: userId } });
      }
    }
  };

  // -------------------------------------------------------------------------------------
  // Entitlement changes — all idempotent: the same event applied twice is a no-op
  // -------------------------------------------------------------------------------------

  const grant = (userId, event, doc) =>
    retryOnDuplicate(() =>
      Entitlement.updateOne(
        { user: userId },
        {
          $set: {
            entitlementId: entitlementId(),
            store: stringOrNull(event.store),
            transactionId: stringOrNull(event.transaction_id),
            grantedAt: dateFromMs(event.purchased_at_ms, doc.receivedAt),
            revokedAt: null,
          },
        },
        { upsert: true }
      )
    );

  const revoke = (userId, event, doc) =>
    Entitlement.updateOne(
      { user: userId, revokedAt: null },
      { $set: { revokedAt: dateFromMs(event.event_timestamp_ms, doc.receivedAt) } }
    );

  const regrant = (userId) =>
    Entitlement.updateOne({ user: userId }, { $set: { revokedAt: null } });

  /** Moves the pass from any of `fromUserIds` to `toUserId`, in one transaction. */
  const transfer = async (fromUserIds, toUserId) => {
    const sources = fromUserIds.filter((id) => id !== toUserId);
    if (!sources.length) {
      return false;
    }
    const session = await mongoose.startSession();
    try {
      let moved = false;
      await session.withTransaction(async () => {
        moved = false;
        const source = await Entitlement.findOne({
          user: { $in: sources },
          entitlementId: entitlementId(),
        })
          .sort({ grantedAt: 1 })
          .session(session)
          .lean();
        if (!source) {
          return;
        }
        await Entitlement.updateOne(
          { user: toUserId },
          {
            $setOnInsert: {
              entitlementId: source.entitlementId,
              store: source.store,
              transactionId: source.transactionId,
              grantedAt: source.grantedAt,
              revokedAt: source.revokedAt,
            },
          },
          { upsert: true, session }
        );
        await Entitlement.deleteMany(
          { user: { $in: sources }, entitlementId: entitlementId() },
          { session }
        );
        moved = true;
      });
      return moved;
    } finally {
      await session.endSession();
    }
  };

  // -------------------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------------------

  const covers = (doc) => doc.entitlementIds.includes(entitlementId());
  const sandboxInProduction = (doc) => config.isProduction && doc.environment === 'SANDBOX';

  const markProcessed = (id) =>
    RevenueCatEvent.updateOne({ _id: id }, { $set: { processedAt: now(), processingError: null } });

  const markUnresolved = (doc) => {
    logger.warn(
      `RevenueCat event ${doc._id} (${doc.type}) matches no account yet; stored for reconciliation`
    );
    return RevenueCatEvent.updateOne({ _id: doc._id }, { $set: { processingError: UNRESOLVED } });
  };

  /** Re-processes stored unresolved events that carry any of `aliases`, oldest first. */
  const reconcile = async (aliases, currentId, depth) => {
    if (!aliases.length || depth >= MAX_RECONCILE_DEPTH) {
      return;
    }
    const stale = await RevenueCatEvent.find({
      _id: { $ne: currentId },
      processingError: UNRESOLVED,
      $or: [{ appUserId: { $in: aliases } }, { aliases: { $in: aliases } }],
    })
      .sort({ receivedAt: 1 })
      .select('_id')
      .lean();
    for (const { _id } of stale) {
      logger.info(`RevenueCat event ${_id} reconciled by event ${currentId}`);
      // eslint-disable-next-line no-await-in-loop
      await processEvent(_id, depth + 1);
    }
  };

  const applyTransfer = async (doc, event, depth) => {
    const fromIds = unique(strings(Array.isArray(event.transferred_from) ? event.transferred_from : []));
    const toIds = unique(strings(Array.isArray(event.transferred_to) ? event.transferred_to : []));
    const from = await resolve(fromIds);
    const to = await resolve(toIds);
    const toUserId = to.userIds[0] || null;

    await linkAliases(to.aliases, toUserId);
    await linkAliases(from.aliases, from.userIds.length === 1 ? from.userIds[0] : null);
    if (!toUserId) {
      await markUnresolved(doc);
      return;
    }
    await reconcile(unique([...to.aliases, ...from.aliases]), doc._id, depth);

    // A TRANSFER may carry no entitlement_ids; the pass it moves is identified by our
    // own record, which only ever holds the configured entitlement id.
    if (doc.entitlementIds.length && !covers(doc)) {
      logger.info(`RevenueCat event ${doc._id} (TRANSFER) is not for ${entitlementId()}; ignored`);
    } else if (sandboxInProduction(doc)) {
      logger.info(`RevenueCat event ${doc._id} (TRANSFER) is SANDBOX in production; not applied`);
    } else if (await transfer(from.userIds, toUserId)) {
      logger.info(`RevenueCat event ${doc._id}: pass moved to account ${toUserId}`);
    } else {
      logger.info(`RevenueCat event ${doc._id} (TRANSFER): no pass on the source account(s) to move`);
    }
    await markProcessed(doc._id);
  };

  const applyToAccount = async (doc, event, userId) => {
    const { type } = doc;
    if (type === 'EXPIRATION') {
      logger.error(
        `RevenueCat EXPIRATION event ${doc._id} for account ${userId}: the pass is lifetime and must never expire. ` +
          'Check the product configuration in the RevenueCat dashboard. Nothing was changed.'
      );
      return;
    }
    if (type === 'TEMPORARY_ENTITLEMENT_GRANT') {
      logger.info(`RevenueCat event ${doc._id} (TEMPORARY_ENTITLEMENT_GRANT): logged only, no money moved`);
      return;
    }
    const changesAccess = ['NON_RENEWING_PURCHASE', 'INITIAL_PURCHASE', 'CANCELLATION', 'REFUND_REVERSED'];
    if (!changesAccess.includes(type)) {
      return;
    }
    if (!covers(doc)) {
      logger.info(`RevenueCat event ${doc._id} (${type}) is not for ${entitlementId()}; ignored`);
      return;
    }
    if (sandboxInProduction(doc)) {
      logger.info(`RevenueCat event ${doc._id} (${type}) is SANDBOX in production; not applied`);
      return;
    }

    if (type === 'INITIAL_PURCHASE') {
      logger.warn(
        `RevenueCat event ${doc._id}: INITIAL_PURCHASE (a subscription event) arrived for a lifetime pass; granted anyway`
      );
    }
    if (type === 'NON_RENEWING_PURCHASE' || type === 'INITIAL_PURCHASE') {
      await grant(userId, event, doc);
    } else if (type === 'CANCELLATION') {
      if (event.cancel_reason === REFUND_REASON) {
        await revoke(userId, event, doc);
      } else {
        logger.info(
          `RevenueCat event ${doc._id}: CANCELLATION with cancel_reason ${String(event.cancel_reason)} ignored (only ${REFUND_REASON} revokes)`
        );
      }
    } else if (type === 'REFUND_REVERSED') {
      await regrant(userId);
    }
  };

  const applyEvent = async (doc, event, depth) => {
    if (doc.type === 'TRANSFER') {
      await applyTransfer(doc, event, depth);
      return;
    }
    const candidates = unique(
      strings(
        event.app_user_id,
        event.original_app_user_id,
        Array.isArray(event.aliases) ? event.aliases : []
      )
    );
    const { userIds, aliases } = await resolve(candidates);
    const userId = userIds[0] || null;
    await linkAliases(aliases, userId);
    if (!userId) {
      await markUnresolved(doc);
      return;
    }
    // Older unresolved events for these aliases first, so they apply in the order they
    // happened (a purchase before its refund).
    await reconcile(aliases, doc._id, depth);
    await applyToAccount(doc, event, userId);
    await markProcessed(doc._id);
  };

  /**
   * Processes a stored event. Never throws: a failure is recorded as processingError.
   * Safe to run more than once on the same event. A function declaration, so the
   * reconciliation above can call it before this line runs.
   */
  async function processEvent(id, depth = 0) {
    try {
      const doc = await RevenueCatEvent.findById(id).lean();
      if (!doc) {
        return;
      }
      await applyEvent(doc, parseEvent(doc.rawBody) || {}, depth);
    } catch (error) {
      logger.error(`RevenueCat event ${id} processing failed: ${error.message}`);
      await RevenueCatEvent.updateOne(
        { _id: id },
        { $set: { processingError: String(error.message).slice(0, 500) } }
      ).catch(() => {});
    }
  }

  /** Processes the event after the current request has been answered. */
  const schedule = (id) => {
    const job = new Promise((resolve) => {
      setImmediate(resolve);
    })
      .then(() => processEvent(id))
      .finally(() => pending.delete(job));
    pending.add(job);
  };

  /** Resolves when every scheduled job has settled. For tests and graceful shutdown. */
  const idle = async () => {
    while (pending.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...pending]);
    }
  };

  return { store, processEvent, schedule, idle };
};

module.exports = {
  ...createRevenueCatService(),
  createRevenueCatService,
  parseEvent,
  UNRESOLVED,
};
