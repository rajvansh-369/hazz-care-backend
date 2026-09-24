# MongoDB Replica Set Setup

## Why Required

Two operations must be atomic across several documents (CLAUDE.md §A8, §A11):

- **Password reset** — mark the reset token consumed, update the password hash, revoke the
  user's refresh tokens.
- **Refresh-token rotation** — issue the successor and link the previous token to it.

A crash part-way through leaves an account inconsistent. MongoDB transactions require a replica
set; a standalone `mongod` refuses them. A single-node replica set is enough for development and CI.

## Configuration

Point `MONGODB_URL` at the replica set. Either put the set name in the URL
(`?replicaSet=rs0`) or set `MONGODB_REPLICA_SET`, which `src/config/config.js` adds to the
connection options:

```bash
# .env
MONGODB_URL=mongodb://127.0.0.1:27018/hajjcare?replicaSet=rs0
# MONGODB_REPLICA_SET=rs0   # alternative to ?replicaSet= in the URL
```

## Development Setup

### Option 1: `npm run db:dev` (recommended)

No install and no admin rights: `scripts/dev-replset.js` runs a one-node replica set named `rs0`
on **port 27018** using `mongodb-memory-server` (already a dev dependency). Data is kept in
`.dev-data/` (wiredTiger, gitignored) and survives restarts. It does not touch any other MongoDB
on the machine — a standalone `mongod` on 27017 can keep running alongside it.

Two terminals:

```bash
# terminal 1 — the database; stays in the foreground, Ctrl+C to stop
npm run db:dev

# terminal 2 — the API
npm run dev
```

`.env` needs:

```bash
MONGODB_URL=mongodb://127.0.0.1:27018/hajjcare?replicaSet=rs0
```

To start from an empty database, stop `db:dev` and delete `.dev-data/`.

### Option 2: Local mongod (Manual)

Start a MongoDB server in replica set mode:

```bash
mongod --replSet rs0 --dbpath /path/to/data
```

Initialize replica set (one-time, in a separate terminal):

```bash
mongosh
> rs.initiate()
```

Verify:
```bash
mongosh
> rs.status()
```

Set env var:
```bash
MONGODB_URL=mongodb://localhost:27017/hajjcare?replicaSet=rs0
```

### Option 3: MongoDB Atlas (Cloud)

Atlas clusters are replica sets by default, and the `mongodb+srv://` URL discovers the set on its
own — do not set `MONGODB_REPLICA_SET`.

Copy connection string from Atlas dashboard:
```bash
MONGODB_URL="mongodb+srv://user:password@cluster.mongodb.net/hajjcare?retryWrites=true&w=majority"
```

## Testing

The test suite needs none of this: suites that use transactions start their own in-memory
replica set (`tests/utils/setupTestDB.js`).

To check a running server, `GET /api/v1/health/ready` reports `"mongodb": "up"`. To check the
database itself:

```bash
mongosh "mongodb://127.0.0.1:27018/?replicaSet=rs0"
> rs.status()
```

`stateStr` should be `PRIMARY` for the single member.

## Checking in Code

Mongoose will fail on transaction attempt without replica set:

```
MongoServerError: Transaction numbers are only allowed on a replica set member or mongos
```

If you see this error: replica set is not initialized. Follow setup above.

## Notes

- Single-node replica set (rs0 with one member) is sufficient for dev/CI
- Production should use 3+ nodes for high availability
- Atlas provides managed replica sets (no setup needed)
- TTL indexes work on standalone MongoDB; transactions require replica set
