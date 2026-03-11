# JSON Streams

Use JSON mode when you want structured messages with preserved boundaries.

JSON mode is enabled by creating the stream with `Content-Type: application/json`.

## What JSON mode does

- Each `POST` stores a distinct JSON message.
- Posting a JSON array stores each element as its own message.
- `GET` returns a JSON array of messages for the requested range.

## Create a JSON stream

```bash
curl -X PUT http://localhost:4437/v1/stream/events \
  -H 'Content-Type: application/json'
```

## Append JSON messages

Append one message:

```bash
curl -X POST http://localhost:4437/v1/stream/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"user.created","id":"123"}'
```

Append multiple messages in one request:

```bash
curl -X POST http://localhost:4437/v1/stream/events \
  -H 'Content-Type: application/json' \
  -d '[{"type":"user.created","id":"123"},{"type":"user.updated","id":"123"}]'
```

The second request stores two messages, not one outer array.

## Read them back

```bash
curl "http://localhost:4437/v1/stream/events?offset=-1"
```

Response:

```json
[
  { "type": "user.created", "id": "123" },
  { "type": "user.updated", "id": "123" }
]
```

## Use JSON mode from the client

::: code-group

```typescript [TypeScript]
import { DurableStream, stream } from "@durable-streams/client"

const events = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/events",
  contentType: "application/json",
})

await events.append({ type: "user.created", id: "123" })

const res = await stream<{ type: string; id: string }>({
  url: "http://localhost:4437/v1/stream/events",
  json: true,
})

const items = await res.json()
console.log(items)
```

```python [Python]
from durable_streams import DurableStream, stream

handle = DurableStream.create(
    "http://localhost:4437/v1/stream/events",
    content_type="application/json",
)

handle.append({"type": "user.created", "id": "123"})

with stream("http://localhost:4437/v1/stream/events") as res:
    items = res.read_json()
    print(items)
```

:::

## When to use it

- Use JSON mode for chat messages, agent events, state updates, and logs.
- Use byte streams for raw binary data or when you already have your own framing format.

## More

- [Core Concepts](concepts.md#messages-and-content-types)
- [State Streams](state.md) for structured state sync on top of JSON streams
