# Coordination Patterns for Durable Streams

**Document:** Coordination Patterns for Durable Streams  
**Version:** 1.0  
**Date:** 2025-02-XX  
**Author:** ElectricSQL  
**Status:** Informational (Patterns using Durable Streams Protocol)

---

## Abstract

This document describes coordination patterns that leverage the Idempotent Producers mechanism of the Durable Streams Protocol [PROTOCOL] to achieve distributed coordination primitives. These patterns enable multiple actors to coordinate task ownership, implement optimistic concurrency control, and perform conflict-free state updates without additional infrastructure.

## Copyright Notice

Copyright (c) 2025 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Pattern Overview](#3-pattern-overview)
4. [Task Claiming](#4-task-claiming)
   - 4.1. [Basic Task Claim](#41-basic-task-claim)
   - 4.2. [Claim with Timeout Override](#42-claim-with-timeout-override)
   - 4.3. [AI Tool Call Coordination](#43-ai-tool-call-coordination)
5. [Optimistic Concurrency Control](#5-optimistic-concurrency-control)
   - 5.1. [Version-Based Updates](#51-version-based-updates)
   - 5.2. [Read-Modify-Write Cycle](#52-read-modify-write-cycle)
   - 5.3. [Conflict Detection and Resolution](#53-conflict-detection-and-resolution)
6. [Override and Recovery](#6-override-and-recovery)
   - 6.1. [Epoch-Based Override](#61-epoch-based-override)
   - 6.2. [Timeout-Based Reclaim](#62-timeout-based-reclaim)
   - 6.3. [Administrative Override](#63-administrative-override)
7. [Integration with State Protocol](#7-integration-with-state-protocol)
8. [Response Interpretation](#8-response-interpretation)
9. [Best Practices](#9-best-practices)
10. [Security Considerations](#10-security-considerations)
11. [References](#11-references)

---

## 1. Introduction

The Durable Streams Protocol [PROTOCOL] defines Idempotent Producers (Section 5.2.1) for exactly-once write semantics. This mechanism—originally designed for retry safety and deduplication—can be repurposed as a powerful coordination primitive for distributed systems.

This document describes patterns that use the three producer headers in novel ways:

- **Producer-Id**: Traditionally identifies a writer; in coordination patterns, identifies a _resource_ or _task_
- **Producer-Epoch**: Traditionally tracks writer restarts; in coordination patterns, enables _override_ and _recovery_
- **Producer-Seq**: Traditionally ensures ordered delivery; in coordination patterns, implements _versioning_ and _compare-and-swap_

These patterns are particularly useful for:

- Coordinating multiple actors processing a shared task queue
- Implementing optimistic locking for state updates
- Managing distributed locks without a dedicated lock service
- Coordinating AI agent tool calls across multiple executors

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Actor**: An entity (process, service instance, serverless function, AI agent) that participates in coordination. Multiple actors may compete for the same resource or task.

**Task**: A unit of work that should be executed by exactly one actor. Tasks are identified by a unique task ID.

**Resource**: An entity (row, document, record) that multiple actors may read and update. Resources have versions that increase monotonically.

**Claim**: An attempt by an actor to take ownership of a task or resource.

**Compare-And-Swap (CAS)**: An atomic operation that updates a value only if it matches an expected value. The operation compares the current value to an expected value and, only if they match, swaps in the new value—all as a single atomic step. If the values don't match, the operation fails and returns the current value. This primitive is fundamental to lock-free concurrent programming and optimistic concurrency control.

**Version**: A monotonically increasing integer representing the state of a resource. Each successful update increments the version.

**Override**: An intentional epoch bump that allows an actor to bypass normal coordination rules, typically for recovery or administrative purposes.

## 3. Pattern Overview

The Idempotent Producer headers enable three coordination patterns:

| Pattern                    | Producer-Id        | Epoch | Seq     | Purpose                                   |
| -------------------------- | ------------------ | ----- | ------- | ----------------------------------------- |
| **Task Claiming**          | `task:{taskId}`    | 0     | 0       | First-writer-wins for task ownership      |
| **Optimistic Concurrency** | `row:{resourceId}` | 0     | version | Sequential versioning with CAS semantics  |
| **Override/Recovery**      | (either)           | bump  | 0       | Timeout recovery, administrative override |

All patterns rely on the server's validation logic for `(stream, producerId, epoch, seq)` tuples:

```
# From PROTOCOL.md Section 5.2.1

if epoch < state.epoch:
  → 403 Forbidden (stale epoch)

if epoch > state.epoch:
  → Accept if seq=0, reset state (new epoch established)

if seq <= state.lastSeq:
  → 204 No Content (duplicate/already claimed)

if seq == state.lastSeq + 1:
  → 200 OK (success)

if seq > state.lastSeq + 1:
  → 409 Conflict (gap)
```

## 4. Task Claiming

Task claiming implements a **first-writer-wins** pattern where multiple actors race to claim ownership of a task, and exactly one succeeds.

### 4.1. Basic Task Claim

**Use case**: Multiple workers watch a queue for new tasks. When a task appears, workers race to claim it. Only one worker should execute the task.

**Key insight**: Use a **task-specific `Producer-Id`** so that all actors compete on the same producer state.

#### Protocol

```
POST {stream-url}
Producer-Id: task:{taskId}
Producer-Epoch: 0
Producer-Seq: 0
Content-Type: application/json

{
  "taskId": "{taskId}",
  "owner": "{actorId}",
  "status": "claimed",
  "claimedAt": "{timestamp}"
}
```

All competing actors use:

- The same `Producer-Id` (derived from task ID, not actor ID)
- `Producer-Epoch: 0`
- `Producer-Seq: 0`

#### Response Interpretation

| Response           | Meaning                     | Actor Action                                         |
| ------------------ | --------------------------- | ---------------------------------------------------- |
| **200 OK**         | You claimed the task        | Execute the task                                     |
| **204 No Content** | Another actor claimed first | Skip this task (optionally read stream to see owner) |

#### Example Flow

```
Task "tool-call-abc123" appears in stream

Actor A (concurrent):
  POST /coordination-stream
  Producer-Id: task:tool-call-abc123
  Producer-Epoch: 0
  Producer-Seq: 0
  Body: {"taskId": "tool-call-abc123", "owner": "actor-a", ...}

Actor B (concurrent):
  POST /coordination-stream
  Producer-Id: task:tool-call-abc123
  Producer-Epoch: 0
  Producer-Seq: 0
  Body: {"taskId": "tool-call-abc123", "owner": "actor-b", ...}

Server processing order: A arrives first, then B

Actor A receives: 200 OK
  → Server state: {producerId: "task:tool-call-abc123", epoch: 0, lastSeq: 0}
  → A's message is stored in stream
  → A executes the task

Actor B receives: 204 No Content, Producer-Seq: 0
  → B's message is NOT stored (deduplication)
  → B skips this task
```

#### Implementation

```javascript
async function claimTask(taskId, actorId) {
  const response = await fetch("/coordination-stream", {
    method: "POST",
    headers: {
      "Producer-Id": `task:${taskId}`,
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      taskId,
      owner: actorId,
      status: "claimed",
      claimedAt: new Date().toISOString(),
    }),
  })

  if (response.status === 200) {
    return { claimed: true, owner: actorId }
  }

  if (response.status === 204) {
    // Someone else claimed it (or we're retrying our own claim)
    // Read the stream to find the actual owner
    const claim = await readTaskClaim(taskId)
    return { claimed: claim.owner === actorId, owner: claim.owner }
  }

  throw new Error(`Unexpected response: ${response.status}`)
}
```

### 4.2. Claim with Timeout Override

**Use case**: An actor claims a task but crashes before completing it. After a timeout, another actor should be able to reclaim the task.

**Key insight**: Use **epoch bumping** to override a stale claim.

#### Protocol

```
# Initial claim (or retry of own claim)
POST {stream-url}
Producer-Id: task:{taskId}
Producer-Epoch: 0
Producer-Seq: 0

# Override after timeout
POST {stream-url}
Producer-Id: task:{taskId}
Producer-Epoch: 1          ← Bumped epoch
Producer-Seq: 0            ← Reset to 0 for new epoch
```

#### Example Flow

```
1. Actor A claims task (epoch=0, seq=0) → 200 OK
2. Actor A crashes
3. Timeout expires (e.g., 30 seconds)
4. Actor B detects stale claim, attempts override:

   POST /coordination-stream
   Producer-Id: task:tool-call-abc123
   Producer-Epoch: 1      ← Epoch > server's epoch (0)
   Producer-Seq: 0
   Body: {"taskId": "...", "owner": "actor-b", "override": true, ...}

5. Actor B receives: 200 OK
   → Server state updated: {epoch: 1, lastSeq: 0}
   → B's claim message stored
   → B executes the task

6. If Actor A (zombie) tries to continue:
   POST with (epoch=0, seq=1)
   → 403 Forbidden (stale epoch)
   → A knows it's been superseded
```

#### Implementation

```javascript
async function claimTaskWithTimeout(taskId, actorId, timeoutMs = 30000) {
  // First, check for existing claim
  const existingClaim = await readTaskClaim(taskId)

  let epoch = 0

  if (existingClaim) {
    const claimAge = Date.now() - new Date(existingClaim.claimedAt).getTime()

    if (existingClaim.owner === actorId) {
      // We already own it (retry scenario)
      return { claimed: true, owner: actorId }
    }

    if (claimAge < timeoutMs) {
      // Claim is still valid, someone else owns it
      return { claimed: false, owner: existingClaim.owner }
    }

    // Claim has timed out, override with higher epoch
    epoch = (existingClaim.epoch || 0) + 1
  }

  const response = await fetch("/coordination-stream", {
    method: "POST",
    headers: {
      "Producer-Id": `task:${taskId}`,
      "Producer-Epoch": String(epoch),
      "Producer-Seq": "0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      taskId,
      owner: actorId,
      epoch,
      status: "claimed",
      claimedAt: new Date().toISOString(),
    }),
  })

  if (response.status === 200) {
    return { claimed: true, owner: actorId }
  }

  if (response.status === 204) {
    // Race condition: someone else claimed/overrode at the same moment
    const claim = await readTaskClaim(taskId)
    return { claimed: claim.owner === actorId, owner: claim.owner }
  }

  if (response.status === 403) {
    // Our epoch is stale, someone else already overrode
    const serverEpoch = parseInt(response.headers.get("Producer-Epoch"))
    return { claimed: false, serverEpoch }
  }

  throw new Error(`Unexpected response: ${response.status}`)
}
```

### 4.3. AI Tool Call Coordination

**Use case**: An AI session produces tool calls that need execution. Multiple executor agents watch the session stream. Each tool call should be executed exactly once.

#### Architecture

```
┌─────────────────┐
│   AI Session    │
│   (Producer)    │
└────────┬────────┘
         │ Writes tool calls
         ▼
┌─────────────────┐
│ Session Stream  │  ← Durable stream with tool call messages
└────────┬────────┘
         │ Multiple readers
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│Agent A│ │Agent B│  ← Executor agents compete to claim
└───────┘ └───────┘
```

#### Protocol for Executors

When an executor sees a tool call:

```
POST /session-{sessionId}/coordination
Producer-Id: tool:{toolCallId}
Producer-Epoch: 0
Producer-Seq: 0
Content-Type: application/json

{
  "toolCallId": "call_abc123",
  "executorId": "agent-a",
  "status": "claimed",
  "claimedAt": "2025-02-01T10:00:00Z"
}
```

#### Complete Flow

```javascript
// Executor agent watching a session stream
async function processToolCalls(sessionId, executorId) {
  const stream = await subscribeToStream(`/session-${sessionId}/messages`)

  for await (const message of stream) {
    if (message.type !== "tool_call") continue

    const toolCallId = message.id

    // Try to claim this tool call
    const claim = await claimTask(toolCallId, executorId)

    if (!claim.claimed) {
      console.log(`Tool call ${toolCallId} claimed by ${claim.owner}, skipping`)
      continue
    }

    console.log(`Executing tool call ${toolCallId}`)

    try {
      const result = await executeToolCall(message)

      // Write result back to session stream
      await appendToStream(`/session-${sessionId}/messages`, {
        type: "tool_result",
        toolCallId,
        executorId,
        result,
      })
    } catch (error) {
      // Write error back to session stream
      await appendToStream(`/session-${sessionId}/messages`, {
        type: "tool_error",
        toolCallId,
        executorId,
        error: error.message,
      })
    }
  }
}
```

## 5. Optimistic Concurrency Control

Optimistic concurrency control implements **compare-and-swap (CAS)** semantics where updates only succeed if the resource is at the expected version.

### 5.1. Version-Based Updates

**Use case**: Multiple actors may update the same resource. Each update should be based on the current state, preventing lost updates.

**Key insight**: Use **`Producer-Seq` as the version number**. The protocol's `seq == lastSeq + 1` requirement enforces that you can only write version N+1 if version N was the last written.

#### Protocol

```
# Writing version 3 (expecting current version to be 2)
POST {stream-url}
Producer-Id: row:{resourceId}
Producer-Epoch: 0
Producer-Seq: 3              ← Version being written
Content-Type: application/json

{
  "type": "user",
  "key": "123",
  "value": {"name": "Alice", "version": 3},
  "headers": {"operation": "update"}
}
```

#### Response Interpretation

| Response           | Headers                    | Meaning                                  | Actor Action              |
| ------------------ | -------------------------- | ---------------------------------------- | ------------------------- |
| **200 OK**         | `Producer-Seq: 3`          | Successfully wrote version 3             | Done                      |
| **204 No Content** | `Producer-Seq: 5`          | Version 3+ already written; current is 5 | Re-read, retry with seq=6 |
| **409 Conflict**   | `Producer-Expected-Seq: 3` | Gap; tried to skip versions              | Fix sequence              |

### 5.2. Read-Modify-Write Cycle

The standard pattern for updating a resource:

```
1. READ:   Get current state at version N
2. MODIFY: Compute new state
3. WRITE:  Attempt to write version N+1
4. RETRY:  On conflict, go back to step 1
```

#### Implementation

```javascript
async function updateResource(resourceId, mutate, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. Read current state
    const current = await readResource(resourceId)
    const currentVersion = current?.version ?? -1 // -1 if doesn't exist

    // 2. Compute new state
    const newValue = mutate(current?.value)
    const newVersion = currentVersion + 1

    // 3. Attempt conditional write
    const response = await fetch("/state-stream", {
      method: "POST",
      headers: {
        "Producer-Id": `row:${resourceId}`,
        "Producer-Epoch": "0",
        "Producer-Seq": String(newVersion),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: current?.type ?? "resource",
        key: resourceId,
        value: { ...newValue, version: newVersion },
        headers: { operation: currentVersion === -1 ? "insert" : "update" },
      }),
    })

    if (response.status === 200) {
      // Success
      return { success: true, version: newVersion, value: newValue }
    }

    if (response.status === 204) {
      // Conflict - someone else wrote first
      const serverVersion = parseInt(response.headers.get("Producer-Seq"))
      console.log(`Conflict: tried v${newVersion}, server at v${serverVersion}`)
      // Loop will re-read and retry
      continue
    }

    if (response.status === 409) {
      // Sequence gap - shouldn't happen in normal operation
      const expected = response.headers.get("Producer-Expected-Seq")
      console.warn(`Sequence gap: expected ${expected}, sent ${newVersion}`)
      continue
    }

    throw new Error(`Unexpected response: ${response.status}`)
  }

  throw new Error(`Failed to update after ${maxRetries} attempts`)
}
```

#### Usage

```javascript
// Increment a counter
await updateResource("counter:visits", (current) => ({
  count: (current?.count ?? 0) + 1,
}))

// Update user profile
await updateResource("user:123", (current) => ({
  ...current,
  email: "newemail@example.com",
  updatedAt: new Date().toISOString(),
}))
```

### 5.3. Conflict Detection and Resolution

When a conflict occurs (204 response), the `Producer-Seq` header tells you the current version:

```javascript
async function updateWithConflictHandler(resourceId, mutate, onConflict) {
  const current = await readResource(resourceId)
  const newVersion = (current?.version ?? -1) + 1

  const response = await fetch("/state-stream", {
    method: "POST",
    headers: {
      "Producer-Id": `row:${resourceId}`,
      "Producer-Epoch": "0",
      "Producer-Seq": String(newVersion),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "resource",
      key: resourceId,
      value: mutate(current?.value),
      headers: { operation: "update" },
    }),
  })

  if (response.status === 204) {
    const serverVersion = parseInt(response.headers.get("Producer-Seq"))

    // Let caller decide how to handle conflict
    const resolution = await onConflict({
      attemptedVersion: newVersion,
      serverVersion,
      localValue: mutate(current?.value),
    })

    if (resolution === "retry") {
      return updateWithConflictHandler(resourceId, mutate, onConflict)
    }
    if (resolution === "abort") {
      return { success: false, reason: "conflict" }
    }
  }

  return { success: response.status === 200, version: newVersion }
}

// Usage with custom conflict handling
await updateWithConflictHandler(
  "document:draft",
  (doc) => ({ ...doc, content: "new content" }),
  async (conflict) => {
    console.log(
      `Conflict: you have v${conflict.attemptedVersion}, server has v${conflict.serverVersion}`
    )
    const userChoice = await promptUser("Retry with latest, or abort?")
    return userChoice
  }
)
```

## 6. Override and Recovery

The epoch mechanism provides an escape hatch for situations where normal coordination rules need to be bypassed.

### 6.1. Epoch-Based Override

**Epochs enable "force write" semantics:**

- Normal writes use `epoch=0` and increment `seq`
- Override writes bump `epoch` and reset `seq=0`
- Higher epochs always win; lower epochs are fenced (403 Forbidden)

#### When to Use Override

| Scenario                               | Action                                 |
| -------------------------------------- | -------------------------------------- |
| Task executor crashed, claim timed out | Bump epoch to reclaim                  |
| Administrative correction needed       | Bump epoch to force update             |
| Schema migration requires reset        | Bump epoch to restart versioning       |
| Recovery from corrupted state          | Bump epoch to establish clean baseline |

### 6.2. Timeout-Based Reclaim

For tasks with heartbeat/timeout semantics:

```javascript
async function reclaimStaleTasks(timeoutMs = 60000) {
  const claims = await readAllClaims()

  for (const claim of claims) {
    const age = Date.now() - new Date(claim.claimedAt).getTime()

    if (age > timeoutMs) {
      console.log(`Task ${claim.taskId} timed out, reclaiming...`)

      const response = await fetch("/coordination-stream", {
        method: "POST",
        headers: {
          "Producer-Id": `task:${claim.taskId}`,
          "Producer-Epoch": String(claim.epoch + 1), // Bump epoch
          "Producer-Seq": "0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          taskId: claim.taskId,
          owner: "reclaim-service",
          epoch: claim.epoch + 1,
          status: "available", // Mark as available for re-execution
          previousOwner: claim.owner,
          reclaimedAt: new Date().toISOString(),
        }),
      })

      if (response.status === 200) {
        console.log(`Reclaimed task ${claim.taskId}`)
      }
    }
  }
}
```

### 6.3. Administrative Override

For administrative corrections that bypass normal versioning:

```javascript
async function adminForceUpdate(resourceId, value, reason) {
  // Get current epoch
  const current = await readResource(resourceId)
  const newEpoch = (current?.epoch ?? 0) + 1

  const response = await fetch("/state-stream", {
    method: "POST",
    headers: {
      "Producer-Id": `row:${resourceId}`,
      "Producer-Epoch": String(newEpoch),
      "Producer-Seq": "0", // Reset sequence for new epoch
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "resource",
      key: resourceId,
      value: {
        ...value,
        version: 0, // Reset version within new epoch
        epoch: newEpoch,
        adminOverride: {
          reason,
          timestamp: new Date().toISOString(),
        },
      },
      headers: { operation: "update" },
    }),
  })

  if (response.status === 200) {
    console.log(`Admin override successful for ${resourceId}`)
    return { success: true, epoch: newEpoch }
  }

  throw new Error(`Admin override failed: ${response.status}`)
}
```

## 7. Integration with State Protocol

When using these patterns with the Durable Streams State Protocol [STATE-PROTOCOL], the coordination headers work alongside the change message format.

### Resource Updates

```
POST /state-stream
Producer-Id: row:user:123
Producer-Epoch: 0
Producer-Seq: 5
Content-Type: application/json

{
  "type": "user",
  "key": "123",
  "value": {
    "name": "Alice Smith",
    "email": "alice@example.com",
    "version": 5
  },
  "headers": {
    "operation": "update",
    "timestamp": "2025-02-01T10:00:00Z"
  }
}
```

### Task Claims as State Changes

```
POST /state-stream
Producer-Id: task:tool-call-abc123
Producer-Epoch: 0
Producer-Seq: 0
Content-Type: application/json

{
  "type": "task_claim",
  "key": "tool-call-abc123",
  "value": {
    "owner": "executor-a",
    "status": "claimed",
    "claimedAt": "2025-02-01T10:00:00Z"
  },
  "headers": {
    "operation": "insert"
  }
}
```

### Version Tracking

The version appears in two places:

1. **In `Producer-Seq`**: For write coordination (server enforces)
2. **In `value.version`**: For readers to observe (client convenience)

Clients **MUST** keep these synchronized. The authoritative version is `Producer-Seq`; the value field is for read convenience.

## 8. Response Interpretation

### Quick Reference

| Status             | Headers                                          | Pattern | Meaning                                            |
| ------------------ | ------------------------------------------------ | ------- | -------------------------------------------------- |
| **200 OK**         | `Producer-Seq`                                   | Both    | Success - your write was accepted                  |
| **204 No Content** | `Producer-Seq`                                   | Both    | Duplicate - someone (maybe you) already wrote this |
| **403 Forbidden**  | `Producer-Epoch`                                 | Both    | Stale epoch - you've been fenced                   |
| **409 Conflict**   | `Producer-Expected-Seq`, `Producer-Received-Seq` | OCC     | Sequence gap - fix your sequence                   |

### Distinguishing "I Already Claimed" from "Someone Else Claimed"

The 204 response doesn't distinguish between your retry and another actor's claim. To determine ownership:

```javascript
async function checkClaimOwnership(taskId, myActorId) {
  const response = await attemptClaim(taskId, myActorId)

  if (response.status === 200) {
    return { owned: true, byMe: true }
  }

  if (response.status === 204) {
    // Read the stored claim to see who owns it
    const claim = await readTaskClaim(taskId)
    return {
      owned: true,
      byMe: claim.owner === myActorId,
      owner: claim.owner,
    }
  }

  return { owned: false }
}
```

## 9. Best Practices

### Task Claiming

1. **Use task-specific Producer-Id**: `task:{taskId}`, not `actor:{actorId}`
2. **All actors use same epoch/seq**: Everyone starts with `(epoch=0, seq=0)`
3. **Include actor identity in body**: So readers can identify the owner
4. **Implement timeout override**: Use epoch bumping for stale claim recovery
5. **Handle 204 gracefully**: Read stream to confirm ownership if needed

### Optimistic Concurrency

1. **Use resource-specific Producer-Id**: `row:{type}:{key}`
2. **Track version in body**: Include `version` field for read convenience
3. **Handle conflicts with retry loop**: Re-read, re-compute, re-try
4. **Set reasonable retry limits**: Avoid infinite loops on high contention
5. **Consider conflict resolution strategy**: Last-writer-wins vs. merge vs. abort

### Override and Recovery

1. **Use epoch sparingly**: Normal operations should use `epoch=0`
2. **Track epoch in body**: Include `epoch` field for recovery logic
3. **Log overrides**: Epoch bumps are significant events worth auditing
4. **Implement timeout detection**: Periodically scan for stale claims

### General

1. **Choose consistent Producer-Id schemes**: Document your naming conventions
2. **Handle all response codes**: Don't assume only 200/204
3. **Persist coordination state**: Claims and versions should survive restarts
4. **Test concurrent scenarios**: Coordination bugs appear under load

## 10. Security Considerations

### Producer-Id Spoofing

Actors could attempt to claim tasks or update resources they shouldn't access by constructing arbitrary `Producer-Id` values.

**Mitigation**: Servers **SHOULD** validate that actors are authorized to use specific `Producer-Id` values. For example, a task coordination stream might only allow executors with appropriate credentials to claim tasks.

### Epoch Abuse

Malicious actors could bump epochs to steal tasks or override legitimate updates.

**Mitigation**:

- Restrict epoch bumping to privileged actors or specific circumstances
- Audit epoch bumps as significant events
- Implement rate limiting on epoch increases

### Denial of Service

An actor could rapidly claim and abandon tasks, preventing legitimate execution.

**Mitigation**:

- Implement claim rate limiting
- Track claim/abandon ratios per actor
- Require completion or explicit release before new claims

### Information Disclosure

Reading the stream reveals claim ownership and version history.

**Mitigation**: Apply appropriate access controls to coordination streams. Consider separate streams for coordination vs. data if access patterns differ.

## 11. References

### Normative References

**[PROTOCOL]**  
Durable Streams Protocol. ElectricSQL, 2025.  
<https://github.com/electric-sql/durable-streams/blob/main/PROTOCOL.md>

**[STATE-PROTOCOL]**  
Durable Streams State Protocol. ElectricSQL, 2025.  
<https://github.com/electric-sql/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md>

**[RFC2119]**  
Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

**[RFC8174]**  
Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

---

**Full Copyright Statement**

Copyright (c) 2025 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
