# Durable Streams — Error Types and Handling

## Error hierarchy

```
Error
├── FetchError              — HTTP transport errors (non-2xx responses)
├── FetchBackoffAbortError  — Backoff retry aborted by signal
├── DurableStreamError      — Protocol-level errors with error codes
│   └── StreamClosedError   — Append to closed stream (409)
├── StaleEpochError         — Producer epoch is stale (403)
└── SequenceGapError        — Unrecoverable producer sequence gap
```

## FetchError

Wraps non-2xx HTTP responses.

```typescript
import { FetchError } from "@durable-streams/client"

try {
  await ds.append(data)
} catch (err) {
  if (err instanceof FetchError) {
    err.status // number — HTTP status code
    err.text // string | undefined — response body
    err.json // object | undefined — parsed JSON body
    err.headers // Record<string, string>
    err.url // string
  }
}
```

## DurableStreamError

Protocol-level errors with typed error codes.

```typescript
import { DurableStreamError } from "@durable-streams/client"

err.code // DurableStreamErrorCode
err.status // number | undefined
err.details // unknown | undefined
```

### Error codes

| Code                | HTTP Status | Cause                                |
| ------------------- | ----------- | ------------------------------------ |
| `NOT_FOUND`         | 404         | Stream does not exist                |
| `CONFLICT_SEQ`      | 409         | Sequence conflict (duplicate or gap) |
| `CONFLICT_EXISTS`   | 409         | Stream already exists (on create)    |
| `BAD_REQUEST`       | 400         | Invalid headers, parameters, or body |
| `BUSY`              | 503         | Server temporarily unavailable       |
| `SSE_NOT_SUPPORTED` | —           | Server does not support SSE          |
| `UNAUTHORIZED`      | 401         | Missing or invalid auth              |
| `FORBIDDEN`         | 403         | Insufficient permissions             |
| `RATE_LIMITED`      | 429         | Rate limit exceeded                  |
| `ALREADY_CONSUMED`  | —           | StreamResponse already consumed      |
| `ALREADY_CLOSED`    | —           | Stream already closed                |
| `PARSE_ERROR`       | —           | Failed to parse response             |
| `STREAM_CLOSED`     | 409         | Append to closed stream              |
| `UNKNOWN`           | —           | Unrecognized error                   |

## StreamClosedError

Extends DurableStreamError. Thrown when appending to a closed stream.

```typescript
import { StreamClosedError } from "@durable-streams/client"

try {
  await ds.append(data)
} catch (err) {
  if (err instanceof StreamClosedError) {
    err.code // "STREAM_CLOSED"
    err.status // 409
    err.finalOffset // string | undefined
  }
}
```

## StaleEpochError

Thrown by IdempotentProducer when the epoch is stale (another producer claimed a higher epoch). Surfaces via `onError` callback, not try/catch.

```typescript
import { StaleEpochError } from "@durable-streams/client"

const producer = new IdempotentProducer(ds, "writer-1", {
  onError: (err) => {
    if (err instanceof StaleEpochError) {
      err.currentEpoch // number — the epoch that fenced this producer
    }
  },
})
```

## SequenceGapError

Unrecoverable sequence gap in IdempotentProducer. Surfaces via `onError`.

```typescript
import { SequenceGapError } from "@durable-streams/client"

// err.expectedSeq — what the server expected
// err.receivedSeq — what was sent
```

## BackoffOptions

Configure exponential backoff with jitter for retries.

```typescript
const response = await stream({
  url: "https://localhost:4437/v1/stream/events",
  backoffOptions: {
    initialDelay: 100,
    maxDelay: 30000,
    multiplier: 2,
    jitter: true,
  },
})
```

## onError recovery handler

For `stream()` and `DurableStream.stream()`, the `onError` callback enables error recovery during live streaming.

```typescript
const response = await stream({
  url: "https://api.example.com/v1/stream/events",
  onError: async (error) => {
    if (error instanceof FetchError && error.status === 401) {
      const newToken = await refreshToken()
      return { headers: { Authorization: `Bearer ${newToken}` } }
    }
    return undefined // propagate error, stop streaming
  },
})
```

Return values:

- `{}` — retry immediately with same config
- `{ headers, params }` — retry with updated values
- `undefined` — propagate error and stop
