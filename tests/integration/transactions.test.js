'use strict';

const mongoose = require('mongoose');
const setupTestDB = require('../utils/setupTestDB');
const { User, Token } = require('../../src/models');

describe('MongoDB Transactions (Replica Set)', () => {
  setupTestDB();

  describe('Transaction support for password reset', () => {
    it('should verify replica set is active', async () => {
      const status = await mongoose.connection.db.admin().replSetGetStatus();
      expect(status.ok).toBe(1);
      expect(status.members).toBeDefined();
      expect(status.members[0].stateStr).toBe('PRIMARY');
    });

    it('should open a session with transaction support', async () => {
      const session = await mongoose.startSession();
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();

      // Start a transaction
      session.startTransaction();
      expect(session.inTransaction()).toBe(true);

      await session.abortTransaction();
      await session.endSession();
    });

    it('should execute and commit a two-write transaction', async () => {
      // Create test collection
      await mongoose.connection.db.createCollection('trans_test');
      const collection = mongoose.connection.db.collection('trans_test');

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Write 1: Insert first document
        await collection.insertOne({ _id: 'doc1', value: 100 }, { session });

        // Write 2: Insert second document
        await collection.insertOne({ _id: 'doc2', value: 200 }, { session });

        // Commit transaction
        await session.commitTransaction();

        // Verify both documents were written
        const docs = await collection.find({}).toArray();
        expect(docs).toHaveLength(2);
      } finally {
        await session.endSession();
      }
    });

    it('should rollback a transaction on abort', async () => {
      await mongoose.connection.db.createCollection('trans_rollback');
      const collection = mongoose.connection.db.collection('trans_rollback');

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Write inside transaction
        await collection.insertOne({ _id: 'will_rollback', value: 999 }, { session });

        // Abort (do NOT commit)
        await session.abortTransaction();

        // Verify document was NOT written
        const doc = await collection.findOne({ _id: 'will_rollback' });
        expect(doc).toBeNull();
      } finally {
        await session.endSession();
      }
    });

    describe('session.withTransaction across two model collections', () => {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const refreshFor = (userId) => {
        const expiresAt = new Date(Date.now() + 60 * DAY_MS);
        return {
          tokenHash: `hash-${new mongoose.Types.ObjectId()}`,
          user: userId,
          type: 'refresh',
          expiresAt,
          purgeAt: new Date(expiresAt.getTime() + 7 * DAY_MS),
        };
      };

      beforeAll(async () => {
        // Collections cannot be created implicitly inside a transaction on every
        // server version, so make sure they exist first.
        await Promise.all([User.createCollection(), Token.createCollection()]);
      });

      it('commits writes to both collections together', async () => {
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            const [user] = await User.create(
              [{ email: 'committed@example.com', passwordHash: 'h' }],
              { session }
            );
            await Token.create([refreshFor(user._id)], { session });
          });
        } finally {
          await session.endSession();
        }

        const user = await User.findOne({ email: 'committed@example.com' });
        expect(user).not.toBeNull();
        await expect(Token.countDocuments({ user: user._id })).resolves.toBe(1);
      });

      it('writes nothing to either collection when the transaction aborts', async () => {
        const session = await mongoose.startSession();
        const failure = new Error('crash between the two writes');
        try {
          await expect(
            session.withTransaction(async () => {
              const [user] = await User.create(
                [{ email: 'aborted@example.com', passwordHash: 'h' }],
                { session }
              );
              await Token.create([refreshFor(user._id)], { session });
              throw failure;
            })
          ).rejects.toBe(failure);
        } finally {
          await session.endSession();
        }

        await expect(User.countDocuments({ email: 'aborted@example.com' })).resolves.toBe(0);
        await expect(Token.countDocuments({})).resolves.toBe(0);
      });
    });

    it('password reset pattern: atomic three-write operation', async () => {
      // This demonstrates the password reset transaction pattern per §A8:
      // 1. Mark reset token consumed
      // 2. Update user password hash
      // 3. Revoke all refresh tokens

      const tokens = mongoose.connection.db.collection('reset_tokens');
      const users = mongoose.connection.db.collection('reset_users');
      const refreshTokens = mongoose.connection.db.collection('reset_refresh_tokens');

      // Create collections
      await Promise.all([
        tokens.drop().catch(() => null),
        users.drop().catch(() => null),
        refreshTokens.drop().catch(() => null),
      ]);

      // Setup: create test data
      const userId = 'user123';
      const tokenId = 'token123';

      await users.insertOne({ _id: userId, email: 'test@example.com', passwordHash: 'old_hash' });
      await tokens.insertOne({ _id: tokenId, userId, consumed: false });
      await refreshTokens.insertOne({ _id: 'refresh1', userId });
      await refreshTokens.insertOne({ _id: 'refresh2', userId });

      // Transaction: atomic three-write operation
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Write 1: Mark reset token consumed
        await tokens.updateOne({ _id: tokenId }, { $set: { consumed: true, consumedAt: new Date() } }, { session });

        // Write 2: Update password hash
        await users.updateOne({ _id: userId }, { $set: { passwordHash: 'new_hash' } }, { session });

        // Write 3: Revoke all refresh tokens for user
        await refreshTokens.updateMany({ userId }, { $set: { revokedAt: new Date() } }, { session });

        await session.commitTransaction();

        // Verify all three writes succeeded
        const updatedToken = await tokens.findOne({ _id: tokenId });
        expect(updatedToken.consumed).toBe(true);
        expect(updatedToken.consumedAt).toBeDefined();

        const updatedUser = await users.findOne({ _id: userId });
        expect(updatedUser.passwordHash).toBe('new_hash');

        const revokedTokens = await refreshTokens.find({ userId, revokedAt: { $exists: true } }).toArray();
        expect(revokedTokens).toHaveLength(2);
      } finally {
        await session.endSession();
      }
    });
  });
});
