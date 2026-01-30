# Durable Streams Error Reference

## Error Classes

### DurableStreamError

Protocol-level errors with codes.

```typescript
import { DurableStreamError } from "@durable-streams/client"

try {
  await handle.stream()
} catch (error) {
  if (error instanceof DurableStreamError) {
    console.log("Code:", error.code)
    console.log("Message:", error.message)
  }
}
```

### FetchError

Transport/network errors including HTTP status codes.

```typescript
import { FetchError } from "@durable-streams/client"

if (error instanceof FetchError) {
  console.log("Status:", error.status) // HTTP status code
  console.log("Response:", error.response)
}
```

### StaleEpochError

Thrown when producer epoch is stale (zombie fencing). Another producer with a higher epoch has taken over.

```typescript
import { StaleEpochError } from "@durable-streams/client"

if (error instanceof StaleEpochError) {
  console.log("Current epoch on server:", error.currentEpoch)
  // Stop this producer - another one is active
}
```

### SequenceGapError

Thrown when sequence numbers are out of order. Should not happen with proper IdempotentProducer usage.

```typescript
import { SequenceGapError } from "@durable-streams/client"

if (error instanceof SequenceGapError) {
  console.log("Expected:", error.expectedSeq)
  console.log("Received:", error.receivedSeq)
}
```

## Error Handling Patterns

### Stream Error Handler

Return new options to retry with different parameters:

```typescript
const res = await stream({
  url,
  onError: async (error) => {
    if (error instanceof FetchError) {
      if (error.status === 401) {
        // Refresh token and retry
        const newToken = await refreshAuthToken()
        return { headers: { Authorization: `Bearer ${newToken}` } }
      }
      if (error.status === 404) {
        // Stream doesn't exist, maybe create it
        throw error // or handle appropriately
      }
      if (error.status >= 500) {
        // Server error, retry with backoff (automatic)
        return {}
      }
    }
    return {} // Retry with same params
  },
})
```

### IdempotentProducer Error Handler

Errors delivered via callback since `append()` is fire-and-forget:

```typescript
const producer = new IdempotentProducer(stream, "id", {
  onError: (error) => {
    if (error instanceof StaleEpochError) {
      // Fenced by another producer
      console.log("Stopping - another producer is active")
      fenced = true
    } else if (error instanceof SequenceGapError) {
      // Should not happen with proper usage
      console.error("Sequence gap detected")
    } else if (error instanceof FetchError) {
      if (error.status === 413) {
        // Batch too large
        console.error("Batch exceeded size limit")
      }
    }
  },
})
```

### Graceful Shutdown on Fencing

```typescript
let fenced = false

const producer = new IdempotentProducer(stream, "id", {
  autoClaim: false, // Don't auto-recover
  onError: (error) => {
    if (error instanceof StaleEpochError) {
      fenced = true
    }
  },
})

for await (const item of source) {
  if (fenced) break
  producer.append(item)
}

if (!fenced) {
  await producer.flush()
}
await producer.close()
```

## HTTP Status Codes

| Status | Meaning                 | Handling                        |
| ------ | ----------------------- | ------------------------------- |
| 200    | Success                 | Process response                |
| 400    | Bad request             | Check request format            |
| 401    | Unauthorized            | Refresh token, retry            |
| 403    | Forbidden / Stale epoch | Check epoch, may be fenced      |
| 404    | Stream not found        | Create stream or handle missing |
| 409    | Conflict                | Sequence/epoch issue            |
| 413    | Payload too large       | Reduce batch size               |
| 429    | Rate limited            | Backoff and retry               |
| 500+   | Server error            | Automatic retry with backoff    |

## Backoff Configuration

Configure retry behavior:

```typescript
const res = await stream({
  url,
  backoffOptions: {
    initialDelayMs: 100, // First retry delay
    maxDelayMs: 30000, // Maximum delay
    multiplier: 2, // Exponential multiplier
    jitterFactor: 0.1, // Randomization factor
    maxRetries: 10, // Max retry attempts
  },
})
```
