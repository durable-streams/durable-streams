# @durable-streams/server-effect

Effect-based implementation of the Durable Streams protocol server.

## Installation

```bash
pnpm add @durable-streams/server-effect
```

## Quick Start

```typescript
import { runServer, StreamStoreLive } from "@durable-streams/server-effect"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"

const program = runServer(4437, "127.0.0.1").pipe(
  Effect.provide(StreamStoreLive)
)

NodeRuntime.runMain(program)
```

## Storage Backends

### In-Memory (Default)

```typescript
import { StreamStoreLive } from "@durable-streams/server-effect"
// Data is lost on restart
```

### Persistent (Effect Persistence - Memory)

```typescript
import { PersistentStreamStoreLive } from "@durable-streams/server-effect"
// Uses Effect's experimental Persistence service with in-memory backing
// Useful for testing the persistence layer without disk I/O
```

### LMDB (Persistent Disk Storage)

```bash
pnpm add lmdb
```

```typescript
import { makePersistentStreamStoreLmdb } from "@durable-streams/server-effect"
const store = makePersistentStreamStoreLmdb("./data/streams")
// Durable storage using LMDB
```

### PostgreSQL

```bash
pnpm add pg
```

First, create the required table:

```sql
CREATE TABLE IF NOT EXISTS persistence_store (
  prefix TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (prefix, key)
);

CREATE INDEX idx_persistence_expires ON persistence_store (expires_at)
  WHERE expires_at IS NOT NULL;
```

Then use the Postgres backend:

```typescript
import {
  makePersistentStreamStoreLayer,
  PersistencePostgres,
} from "@durable-streams/server-effect"
import { Layer } from "effect"

const store = makePersistentStreamStoreLayer().pipe(
  Layer.provide(
    PersistencePostgres.layer({
      host: "localhost",
      port: 5432,
      database: "durable_streams",
      user: "postgres",
      password: "password",
    })
  )
)
```

## Environment Variables

| Variable        | Default           | Description                                                 |
| --------------- | ----------------- | ----------------------------------------------------------- |
| `PORT`          | `4437`            | Server port                                                 |
| `HOST`          | `127.0.0.1`       | Server host                                                 |
| `STORE_BACKEND` | `memory`          | Storage backend: `memory`, `persistent`, `lmdb`, `postgres` |
| `LMDB_PATH`     | `./data/streams`  | Path for LMDB storage                                       |
| `PGHOST`        | `localhost`       | PostgreSQL host                                             |
| `PGPORT`        | `5432`            | PostgreSQL port                                             |
| `PGDATABASE`    | `durable_streams` | PostgreSQL database                                         |
| `PGUSER`        | `postgres`        | PostgreSQL user                                             |
| `PGPASSWORD`    | -                 | PostgreSQL password                                         |

## Running Conformance Tests

### Prerequisites

```bash
# From monorepo root
pnpm install
pnpm build
```

### Run All Tests

```bash
# From monorepo root - runs client + server tests
pnpm test:run
```

### Run Server Conformance Tests Only

```bash
# Start the server
cd packages/server-effect
pnpm start

# In another terminal, run conformance tests
npx @durable-streams/server-conformance-tests --run http://localhost:4437
```

### Watch Mode (Development)

```bash
# Start server in dev mode
cd packages/server-effect
pnpm dev

# Run conformance tests in watch mode
npx @durable-streams/server-conformance-tests --watch src http://localhost:4437
```

### Test Specific Client

```bash
# TypeScript client
pnpm test:run -- --client typescript

# Python client
pnpm test:run -- --client python

# Go client
pnpm test:run -- --client go
```

## API

### `runServer(port, host, config?)`

Starts the HTTP server as an Effect.

```typescript
import {
  runServer,
  ServerConfigService,
  StreamStoreLive,
} from "@durable-streams/server-effect"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"

const program = Effect.gen(function* () {
  const config = yield* ServerConfigService
  yield* runServer(4437, "127.0.0.1", config)
}).pipe(
  Effect.provide(StreamStoreLive),
  Effect.provide(ServerConfigService.Default)
)

NodeRuntime.runMain(program)
```

### `makeServerLayer(port, host, config?)`

Creates a Layer for composing with other services.

### `StreamStoreService`

The stream store service tag for dependency injection.

```typescript
import { StreamStoreService } from "@durable-streams/server-effect"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const store = yield* StreamStoreService
  const stream = yield* store.create("/my-stream", {
    contentType: "application/json",
  })
  yield* store.append(
    "/my-stream",
    new TextEncoder().encode('{"hello":"world"}')
  )
})
```

### Storage Layer Composition

You can compose storage layers with custom configuration:

```typescript
import {
  makePersistentStreamStoreLayer,
  StreamStoreService,
} from "@durable-streams/server-effect"
import { Persistence } from "@effect/experimental"
import { Effect, Layer } from "effect"

// With custom persistence backend
const customStore = makePersistentStreamStoreLayer({
  producerStateTtl: "7 days",
}).pipe(Layer.provide(Persistence.layerResultLmdb({ directory: "./my-data" })))
```

## License

Apache-2.0
