# Exactly-Once Write Primitives: Research & Recommendation

## Executive Summary

This document analyzes approaches for ensuring fast, exactly-once writes from producers in durable-streams. After surveying Kafka, Pulsar, RabbitMQ Streams, NATS JetStream, Redis Streams, AWS Kinesis, Google Pub/Sub, Azure Event Hubs, and academic research, we recommend:

**Primary primitive**: Kafka-style idempotent producer with pipelining
- Simple API: fire writes, await flush, handle errors via callback
- Fast: 5 in-flight batches eliminates RTT bottleneck (5x current throughput)
- Safe: server-side deduplication via producer ID + sequence numbers
- Proven: 8+ years in production at Kafka, adopted by Pulsar and RabbitMQ

**Secondary (optional)**: OCC via `If-Match` header for multi-writer coordination

**Defer**: WebSocket API (optimization, not semantic guarantee)

---

## Table of Contents

1. [Theoretical Foundation](#theoretical-foundation)
2. [Industry Survey](#industry-survey)
3. [Current State in durable-streams](#current-state-in-durable-streams)
4. [Analysis of Proposed Features](#analysis-of-proposed-features)
5. [Recommendation](#recommendation)
6. [Proposed API](#proposed-api)
7. [Implementation Details](#implementation-details)
8. [Migration Path](#migration-path)
9. [References](#references)

---

## Theoretical Foundation

### The Impossibility Result

Exactly-once *delivery* is mathematically impossible. This follows from two foundational results:

1. **Two Generals Problem**: Consensus over a lossy network cannot be guaranteed. If a protocol existed for exactly-once delivery, it could solve the Two Generals Problem—but we know that's impossible.

2. **FLP Impossibility** (Fischer, Lynch, Paterson 1985): No algorithm deterministically solves consensus in an asynchronous environment when even one process can crash.

### What We Can Achieve

While exactly-once *delivery* is impossible, exactly-once *processing* (or "effectively-once semantics") is achievable through:

```
Exactly-Once Processing = At-Least-Once Delivery + Idempotent Deduplication
```

As Jay Kreps (Kafka co-creator) clarified:
> "'Delivery' is a transport semantic. 'Processing' is an application semantic."

The practical approach used by all major streaming systems:
1. Retry failed sends (at-least-once delivery)
2. Deduplicate at the receiver (idempotent processing)
3. Result: each message affects state exactly once

---

## Industry Survey

### Comparison Matrix

| System | Dedup Mechanism | Dedup Scope | Pipelining | Producer Restart | Overhead |
|--------|-----------------|-------------|------------|------------------|----------|
| **Kafka** | Producer ID + Epoch + Seq | Unbounded (in log) | 5 in-flight | Epoch bump | Very low |
| **Pulsar** | Producer Name + Seq ID | Configurable | Yes | Query last seq | Very low |
| **RabbitMQ Streams** | Producer Name + Publish ID | Unbounded | Yes | Query last ID | Low |
| **NATS JetStream** | `Nats-Msg-Id` header | 2 min window | Yes | App manages | Low |
| **Redis Streams** | Consumer-side (PEL) | N/A | N/A | N/A | Medium |
| **AWS Kinesis** | None built-in | N/A | N/A | App manages | N/A |
| **Google Pub/Sub** | Server-side (pull only) | Session-based | N/A | N/A | Medium |
| **Azure Event Hubs** | Seq numbers (optional) | Session-based | Limited | Query state | Medium |

### Detailed Analysis

#### Apache Kafka (KIP-98)

The industry gold standard, introduced in Kafka 0.11 (2017), default since Kafka 3.0.

**Mechanism:**
- **Producer ID (PID)**: Assigned by broker on initialization
- **Epoch**: Incremented on producer restart, prevents "zombie" producers
- **Sequence number**: Per topic-partition, monotonically increasing per batch
- **Broker validation**:
  - `seq < last`: Duplicate, return success (idempotent)
  - `seq == last + 1`: Accept, update last
  - `seq > last + 1`: Reject (gap indicates lost messages)

**Key design decisions:**
- Sequence state persisted *in the log itself* (no separate state store)
- Pipelining up to 5 in-flight requests without breaking ordering
- Overhead: "just a few extra numeric fields with each batch"

**Performance:** "For the same value of max.in.flight.requests and acks, enabling idempotence alone does not significantly impact performance."

#### Apache Pulsar (PIP-6)

Similar to Kafka, with explicit producer naming.

**Mechanism:**
- **Producer Name**: User-provided, stable identifier
- **Sequence ID**: Application-managed, strictly increasing
- **Deduplication cursor**: Stored in BookKeeper
- **Broker maintains**: Map of Producer Name → Last Sequence ID

**Key difference:** Producer name is explicit (good for debugging), not auto-assigned.

**Performance:** "Extensive testing has found no measurable overhead in terms of throughput or latency degradation when deduplication is enabled."

#### RabbitMQ Streams

Follows the Kafka pattern closely.

**Mechanism:**
- **Producer Name**: Must be unique per stream, stable across restarts
- **Publishing ID**: Strictly increasing (gaps allowed)
- **Broker filtering**: Rejects ID ≤ last confirmed, still sends ack
- **Recovery**: `GetLastPublishedId()` API for resuming after restart

**Key insight:** Even filtered duplicates receive confirmations—the producer doesn't need to know if it was a duplicate.

#### NATS JetStream

Time-windowed deduplication with a header-based approach.

**Mechanism:**
- **Message header**: `Nats-Msg-Id` for deduplication
- **Time window**: 2 minutes default (configurable in nanoseconds)
- **Double ack**: Server acknowledges the client's ack

**Alternative approach:** `DiscardNewPerSubject` with max 1 message per subject provides infinite deduplication by embedding the unique ID in the subject name.

**Trade-off:** Simpler implementation, but time-bounded window may miss duplicates after window expires.

#### Redis Streams

Different model—consumer-side deduplication only.

**Mechanism:**
- **No producer dedup**: Server assigns message IDs
- **Pending Entries List (PEL)**: Tracks delivered-but-unacked messages
- **XACK**: Explicit acknowledgment removes from PEL
- **Message claiming**: Other consumers can claim stuck messages

**Trade-off:** Shifts deduplication burden to consumers. Not suitable when producer-side exactly-once is required.

#### AWS Kinesis

No native producer-side deduplication.

**Recommendation from AWS:**
- Embed idempotency keys in records
- Deduplicate at consumer using DynamoDB conditional writes
- Design consumers to be naturally idempotent

**Quote:** "Consumer applications should be designed to handle duplicate records gracefully since Kinesis guarantees at-least-once delivery."

#### Google Cloud Pub/Sub

Server-side deduplication for pull subscriptions (GA December 2022).

**Limitations:**
- Pull subscriptions only (not push)
- Single-region guarantee only
- ~1000 msg/sec throughput with ordering keys

#### Azure Event Hubs

Optional idempotent publishing (design phase).

**Mechanism:**
- Producer Group ID + Owner Level + Sequence Number
- Client queries partition state on connect

**Important caveat:** "Enabling idempotent retries does not guarantee exactly-once semantics. The existing Event Hubs at-least-once delivery contract still applies."

### Academic Foundations

#### MillWheel (Google, 2013)

Seminal paper on exactly-once stream processing at scale.

**Key concepts:**
- **Strong productions**: Checkpoint before sending downstream
- **Weak productions**: Opt-out for performance-critical paths
- **Low watermarks**: Logical time for aggregations

**Quote:** "Billing pipelines depend on MillWheel's exactly-once guarantees."

#### Chandy-Lamport Snapshots (1985)

Foundation for Flink's checkpointing:
- Barrier injection into data streams
- Distributed consistent snapshots
- Recovery = restore state + replay from source

#### State Machine Replication

Zab (ZooKeeper) enforces idempotent state transitions—same state change applied multiple times yields the same result.

---

## Current State in durable-streams

### What We Have

| Feature | Implementation | Guarantee |
|---------|----------------|-----------|
| **Sequence numbers** | `Stream-Seq` header, lexicographic comparison | Writer coordination (prevents interleaving) |
| **Batching** | `fastq` with concurrency=1 | One POST in flight, messages accumulated |
| **Auto-batching** | Enabled by default | Opportunistic batching while request in flight |

### What's Missing

1. **No producer identity**: Can't distinguish retry from new write
2. **No server-side deduplication**: Timeout + retry = duplicate
3. **Limited throughput**: Concurrency=1 means one RTT per batch

### The Gap

Current sequence numbers prevent *interleaving* from concurrent writers, but don't prevent *duplication* from retries:

```
Producer sends batch (seq=5)
    → Network timeout (did server receive it?)
Producer retries with seq=6
    → If server received both: duplicate data
```

---

## Analysis of Proposed Features

### 1. Kafka-style Idempotent Producer (PR #51)

**Problem solved:** "Network failures create uncertainty—when a request times out, you don't know if the server received it."

**Proposed mechanism:**
- Producer ID + Epoch assigned by server
- Sequence numbers per batch
- Server deduplicates: returns 204 for duplicates
- Pipelining: up to 5 in-flight batches

**Verdict: ✅ RECOMMENDED as core primitive**

This is the industry-proven pattern used by Kafka, Pulsar, and RabbitMQ. It directly addresses the gap in our current implementation.

### 2. OCC via If-Match (Issue #32)

**Problem solved:** "Multiple writers need to coordinate—detect if someone else wrote since I last read."

**Proposed mechanism:**
- `If-Match` header with expected offset
- 412 Precondition Failed on mismatch
- `Stream-Next-Offset` in response for retry logic

**Verdict: ✅ KEEP as optional feature (different use case)**

OCC and idempotent producers solve *different* problems:

| Scenario | Idempotent Producer | OCC |
|----------|---------------------|-----|
| Retry after timeout | ✅ Handles safely | ❌ May get 412 |
| Concurrent writers | ❌ Both succeed | ✅ Conflict detection |
| "Append only if offset=X" | ❌ Not supported | ✅ Core feature |

**Example where OCC matters but idempotent producer doesn't help:**
```
Writer A reads stream at offset 5, prepares update
Writer B appends, stream now at offset 6
Writer A appends:
  - With idempotent producer: succeeds (no duplicate)
  - With OCC (If-Match: 5): returns 412 (conflict detected)
```

### 3. WebSocket API (Issue #5)

**Problem solved:** "HTTP request/response adds latency; WebSocket enables continuous streaming."

**Proposed mechanism:**
- Persistent connection
- Async acknowledgments after fsync
- Sliding window for in-flight messages

**Verdict: ⏸️ DEFER**

WebSocket is a *transport optimization*, not a *semantic guarantee*. Analysis:

1. **HTTP + pipelining already fast**: 5 in-flight batches eliminates most RTT overhead
2. **Complexity cost**: Reconnection logic, state synchronization, proxy issues
3. **Industry precedent**: Kafka and Pulsar use TCP/HTTP, not WebSocket
4. **Can add later**: Clear optimization target if latency becomes critical

---

## Recommendation

### Primary: Kafka-style Idempotent Producer

Implement the Kafka-style idempotent producer as the core exactly-once primitive.

**Why:**
1. **Industry proven**: 8+ years in Kafka, adopted by Pulsar, RabbitMQ
2. **Simple API**: Fire-and-forget with error callback
3. **Fast**: 5x throughput improvement via pipelining
4. **Low overhead**: Few numeric fields per batch
5. **Matches use case**: Single producer streaming data

### Secondary: OCC (Optional)

Keep OCC (`If-Match` header) as an optional feature for multi-writer coordination.

**Why:**
- Different use case from idempotent producer
- Some users genuinely need compare-and-swap semantics
- Can be used alongside idempotent producer

### Defer: WebSocket

Defer WebSocket API until latency is a proven bottleneck.

**Why:**
- Pipelining provides most of the benefit
- Significant implementation complexity
- No semantic improvement, only performance

### Relationship to Current Primitives

| Primitive | Keep? | Relationship |
|-----------|-------|--------------|
| `Stream-Seq` header | Yes | App-level coordination, complementary |
| Batching (concurrency=1) | Replace | Upgrade to pipelining (concurrency=5) |
| `If-Match` (OCC) | Yes | Optional, orthogonal feature |

---

## Proposed API

### Producer Client

```typescript
interface IdempotentProducerOptions {
  stream: DurableStream

  // Pipelining configuration
  maxInFlight?: number        // Default: 5
  maxBatchBytes?: number      // Default: 1MB
  lingerMs?: number           // Default: 0 (send immediately when idle)

  // Callbacks
  onBatchAck?: (result: BatchResult) => void
  onError?: (error: Error, batch: PendingBatch) => void
}

class IdempotentProducer {
  constructor(options: IdempotentProducerOptions)

  // Fire-and-forget append (queued for batching)
  append(data: unknown, options?: AppendOptions): void

  // Wait for all pending batches to be acknowledged
  flush(): Promise<void>

  // Graceful shutdown
  close(): Promise<void>

  // Stats
  readonly pendingCount: number
  readonly inFlightCount: number
}
```

### Usage Example

```typescript
const producer = new IdempotentProducer({
  stream,
  maxInFlight: 5,
  onError: (error, batch) => {
    console.error(`Failed to write ${batch.count} messages:`, error)
    // Handle error (e.g., write to dead letter queue)
  }
})

// Fire-and-forget - producer handles batching and retries
for (const event of events) {
  producer.append(event)
}

// Wait for all writes to complete
await producer.flush()
```

### Server Protocol

**Request (client-provided producer ID, server-managed epoch):**
```http
POST /stream/my-stream HTTP/1.1
Content-Type: application/json
X-Producer-Id: order-service-1
X-Producer-Seq: 0

[{"event": "click"}, {"event": "scroll"}]
```

Note: Client sends `X-Producer-Id` and `X-Producer-Seq`. Server manages epochs internally.

**Response (success - first write or new epoch):**
```http
HTTP/1.1 201 Created
X-Stream-Offset: 00000042
X-Producer-Epoch: 1
```

**Response (success - subsequent write):**
```http
HTTP/1.1 201 Created
X-Stream-Offset: 00000043
```

**Response (duplicate - already received this seq):**
```http
HTTP/1.1 204 No Content
```

**Response (sequence gap - missing messages):**
```http
HTTP/1.1 409 Conflict
X-Expected-Seq: 5
X-Received-Seq: 7
```

**Response (stale epoch - zombie producer from old session):**
```http
HTTP/1.1 403 Forbidden
X-Error: stale-epoch
X-Current-Epoch: 2
```

---

## Implementation Details

### Server-Side State

```typescript
interface ProducerState {
  producerId: string
  epoch: number
  lastSeq: number
  lastUpdated: number  // For cleanup of stale producers
}

// Per-stream map of producer states
// Can be stored in-memory with periodic snapshots, or inline with messages
streamProducers: Map<string, ProducerState>
```

### Sequence Validation Logic

```typescript
function validateProducerWrite(
  stream: Stream,
  producerId: string,
  epoch: number,
  seq: number
): 'accept' | 'duplicate' | 'gap' | 'stale-epoch' {
  const state = stream.producers.get(producerId)

  if (!state) {
    // New producer, accept and initialize
    stream.producers.set(producerId, { producerId, epoch, lastSeq: seq })
    return 'accept'
  }

  if (epoch < state.epoch) {
    // Zombie producer from old epoch
    return 'stale-epoch'
  }

  if (epoch > state.epoch) {
    // New epoch, reset sequence tracking
    state.epoch = epoch
    state.lastSeq = seq
    return 'accept'
  }

  // Same epoch, check sequence
  if (seq <= state.lastSeq) {
    return 'duplicate'  // Already seen, idempotent ack
  }

  if (seq > state.lastSeq + 1) {
    return 'gap'  // Missing messages, reject
  }

  // seq === state.lastSeq + 1
  state.lastSeq = seq
  return 'accept'
}
```

### Producer ID Assignment

**Option A: Server-assigned (like Kafka)**
```http
POST /stream/my-stream/producer HTTP/1.1

Response:
{
  "producerId": "p-abc123",
  "epoch": 1
}
```

Downside: Requires 1 RTT before first write. For low-latency use cases, this overhead is significant.

**Option B: Client-provided with server-managed epochs (like Pulsar)** ✅ RECOMMENDED
```http
POST /stream/my-stream HTTP/1.1
X-Producer-Id: order-service-1
X-Producer-Seq: 0

Response:
HTTP/1.1 201 Created
X-Producer-Epoch: 1
```

**Why client-provided is better for durable-streams:**

1. **Zero RTT to first byte**: Producer can send data immediately, no handshake required
2. **Simpler protocol**: No separate producer registration endpoint
3. **Better debugging**: Meaningful names like `order-service-1` vs opaque IDs like `p-abc123`
4. **Stateless clients**: Client doesn't need to persist server-assigned ID

**How epochs work with client-provided IDs:**

- Server tracks `(producerId, epoch, lastSeq)` per stream
- On first write from a producer ID: epoch=1, accept
- On write with seq=0 (restart): bump epoch, reset sequence tracking
- Old epoch writes rejected as stale (zombie fencing)

```typescript
// Client generates stable ID (e.g., from config, hostname, or UUID persisted to disk)
const producerId = process.env.PRODUCER_ID ?? `${hostname()}-${processId}`

// First write includes producer ID, server assigns epoch
producer.append(data)  // X-Producer-Id: web-server-1, X-Producer-Seq: 0
                       // Response: X-Producer-Epoch: 1

// Subsequent writes in same session
producer.append(data)  // X-Producer-Id: web-server-1, X-Producer-Seq: 1
```

**Epoch bump on restart:**
```
Session 1: seq 0, 1, 2, 3... (epoch 1)
[crash/restart]
Session 2: seq 0 → server sees seq reset, bumps to epoch 2
           seq 1, 2, 3... (epoch 2)

If zombie from session 1 sends seq=4 with epoch=1 → rejected (stale epoch)
```

### Pipelining Implementation

```typescript
class IdempotentProducer {
  #inFlight: Map<number, PendingBatch> = new Map()
  #nextSeq: number = 0
  #maxInFlight: number = 5

  async #sendBatch(batch: QueuedMessage[]): Promise<void> {
    // Wait if at max in-flight
    while (this.#inFlight.size >= this.#maxInFlight) {
      await this.#waitForAck()
    }

    const seq = this.#nextSeq++
    const pending = { seq, batch, promise: new Deferred() }
    this.#inFlight.set(seq, pending)

    // Send without waiting (pipelining)
    this.#doSend(pending).catch(err => this.#handleError(err, pending))
  }

  async #doSend(pending: PendingBatch): Promise<void> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        'X-Producer-Id': this.#producerId,
        'X-Producer-Seq': String(pending.seq),
      },
      body: JSON.stringify(pending.batch.map(m => m.data))
    })

    if (response.status === 201 || response.status === 204) {
      // Success or duplicate (both are fine)
      this.#inFlight.delete(pending.seq)
      pending.promise.resolve()
    } else if (response.status === 409) {
      // Gap - missing messages, surface error to application
      this.#handleGap(pending, response)
    } else if (response.status === 403) {
      // Stale epoch - this producer session is zombied
      // Another instance with same ID started a new session
      this.#handleStaleEpoch(pending, response)
    }
  }
}
```

---

## Migration Path

### Phase 1: Add Idempotent Producer (Non-Breaking)

1. Add `IdempotentProducer` class alongside existing `DurableStream`
2. Add server-side producer state tracking
3. Existing code continues to work unchanged

### Phase 2: Deprecate Direct Batching

1. Mark `DurableStream.append()` with batching as deprecated
2. Encourage migration to `IdempotentProducer`
3. Update documentation

### Phase 3: Default Behavior

1. Consider making idempotent producer the default
2. Similar to Kafka 3.0 making `enable.idempotence=true` the default

---

## Open Questions

1. **Producer state storage**: In-memory with snapshots vs. inline with messages?
   - Kafka stores inline (sequence in message metadata)
   - Trade-off: Memory vs. recovery complexity

2. **Producer ID lifetime**: How long to retain producer state?
   - Kafka: Until log segment is deleted
   - Could use TTL with periodic refresh

3. ~~**Epoch assignment**: Server-assigned vs. client-provided?~~ **RESOLVED**
   - **Decision**: Client-provided IDs with server-managed epochs (Pulsar-style)
   - **Rationale**: Zero RTT to first byte is critical for low-latency use cases

4. **Gap handling**: Reject vs. buffer-and-reorder?
   - Kafka rejects (client retries)
   - Simpler server, pushes complexity to client

---

## References

### Industry Documentation

- [KIP-98: Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
- [Confluent: Exactly-once Semantics in Kafka](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
- [Pulsar PIP-6: Guaranteed Message Deduplication](https://github.com/apache/pulsar/wiki/PIP-6:-Guaranteed-Message-Deduplication)
- [RabbitMQ Streams: Message Deduplication](https://www.rabbitmq.com/blog/2021/07/28/rabbitmq-streams-message-deduplication)
- [NATS JetStream Model Deep Dive](https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive)
- [Redis Streams Documentation](https://redis.io/docs/latest/develop/data-types/streams/)
- [Google Pub/Sub Exactly-Once Delivery](https://cloud.google.com/pubsub/docs/exactly-once-delivery)
- [Azure Event Hubs Idempotent Producer Design](https://gist.github.com/jsquire/caeacd165785a35811e00292203eb36d)

### Academic Papers

- [MillWheel: Fault-Tolerant Stream Processing at Internet Scale](https://research.google/pubs/millwheel-fault-tolerant-stream-processing-at-internet-scale/) (Google, 2013)
- [Lightweight Asynchronous Snapshots for Distributed Dataflows](https://arxiv.org/abs/1506.08603) (Flink checkpointing)
- [Impossibility of Distributed Consensus with One Faulty Process](https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf) (FLP, 1985)

### Blog Posts & Analysis

- [Jay Kreps: Exactly-once Support in Apache Kafka](https://medium.com/@jaykreps/exactly-once-support-in-apache-kafka-55e1fdd0a35f)
- [The Impossibility of Exactly-Once Delivery](https://blog.bulloak.io/post/20200917-the-impossibility-of-exactly-once/)
- [Flink Checkpointing Internals](https://nightlies.apache.org/flink/flink-docs-release-1.8/internals/stream_checkpointing.html)

### Related Issues & PRs

- [PR #51: Kafka-style Idempotent Producers](https://github.com/durable-streams/durable-streams/pull/51)
- [Issue #32: OCC Support](https://github.com/durable-streams/durable-streams/issues/32)
- [Issue #5: WebSocket API](https://github.com/durable-streams/durable-streams/issues/5)
