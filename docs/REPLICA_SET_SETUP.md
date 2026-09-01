# MongoDB Replica Set Setup

## Why Required

Password reset transaction needs atomic writes (§A8):
1. Mark reset token consumed
2. Update user password
3. Revoke all refresh tokens

A crash between these leaves the account in an inconsistent state. Mongoose transactions require a MongoDB replica set.

## Configuration

Environment variable: `MONGODB_REPLICA_SET`

```bash
# .env
MONGODB_REPLICA_SET=rs0  # or your replica set name
```

Mongoose connection will automatically add `replicaSet` option to connection parameters (src/config/config.js line 82):

```javascript
...(envVars.MONGODB_REPLICA_SET && { replicaSet: envVars.MONGODB_REPLICA_SET })
```

## Development Setup

### Option 1: Docker Compose (Recommended)

```yaml
# docker-compose.yml
version: '3.8'
services:
  mongodb:
    image: mongo:7.0
    ports:
      - "27017:27017"
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: password
    command: --replSet rs0
    volumes:
      - mongo_data:/data/db

volumes:
  mongo_data:
```

Start MongoDB:
```bash
docker-compose up -d mongodb
```

Initialize replica set (one-time):
```bash
docker-compose exec mongodb mongosh --eval "rs.initiate()"
```

Verify:
```bash
docker-compose exec mongodb mongosh --eval "rs.status()"
```

Set env var:
```bash
export MONGODB_REPLICA_SET=rs0
export MONGODB_URL=mongodb://root:password@localhost:27017/hazz-care?authSource=admin
```

### Option 2: Local mongod (Manual)

Start standalone MongoDB in replica set mode:

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
export MONGODB_REPLICA_SET=rs0
export MONGODB_URL=mongodb://localhost:27017/hazz-care
```

### Option 3: MongoDB Atlas (Cloud)

Atlas clusters are replica sets by default.

Copy connection string from Atlas dashboard:
```bash
export MONGODB_URL="mongodb+srv://user:password@cluster.mongodb.net/hazz-care?retryWrites=true&w=majority"
export MONGODB_REPLICA_SET=atlas  # or your cluster name
```

## Testing

Replica set is active when:

```bash
mongosh
> rs.status()
```

Returns:
```json
{
  "ok" : 1,
  "members" : [
    {
      "name" : "localhost:27017",
      "health" : 1,
      "state" : 1,  // 1 = PRIMARY
      "stateStr" : "PRIMARY"
    }
  ]
}
```

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
