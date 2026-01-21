---
'@durable-streams/client': minor
---

**BREAKING**: `append()` now requires pre-serialized JSON strings instead of auto-stringifying objects.

Before:
```typescript
producer.append({ message: "hello" })
```

After:
```typescript
producer.append(JSON.stringify({ message: "hello" }))
```

This aligns with how Kafka, SQS, and other streaming APIs work - they require pre-serialized data, giving users control over serialization. If you already have JSON from an API response, you can now pass it directly without parsing and re-stringifying.

This change affects the TypeScript, Python, Go, PHP, and .NET clients.
