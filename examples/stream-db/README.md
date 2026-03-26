# StreamDB Demo

Three entity types (messages, presence, agents) multiplexed on a single [Durable Stream](https://durablestreams.com) using [StreamDB](https://durablestreams.com/stream-db).

See the [StreamDB blog post](https://electric-sql.com/blog/2026/03/26/stream-db) for more context.

## Setup

### 1. Provision a StreamDB

Go to [Electric Cloud](https://dashboard.electric-sql.cloud) to [provision a StreamDB service](https://dashboard.electric-sql.cloud/?intent=create&serviceType=streams&serviceVariant=state).

Copy the stream URL and secret.

### 2. Create a stream

Follow the instructions to create a stream, e.g.:

```sh
npx @durable-streams/cli \
  --url 'https://api.electric-sql.cloud/v1/stream/:service' \
  --auth 'Bearer <your secret>' \
  --content-type application/json \
  create my-db
```

### 3. Configure environment

```sh
cp .env.template .env
```

Edit `.env` with your stream URL and secret:

```
VITE_STREAM_URL="https://api.electric-sql.cloud/v1/stream/:service/my-db"
VITE_STREAM_SECRET="..."
```

### 4. Install and run

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173
