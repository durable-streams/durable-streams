# The Durable Streams State Protocol

**Document:** Durable Streams State Protocol  
**Version:** 1.0  
**Date:** 2025-01-XX  
**Author:** ElectricSQL  
**Status:** Extension of Durable Streams Protocol

---

## Abstract

This document specifies the Durable Streams State Protocol, an extension of the Durable Streams Protocol [PROTOCOL] that defines a composable schema for state change events (insert/update/delete) and control messages. The protocol provides a shared vocabulary for state synchronization that works across different transport layers, storage backends, and application patterns, enabling database-style sync semantics over durable streams.

## Copyright Notice

Copyright (c) 2025 ElectricSQL

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Protocol Overview](#3-protocol-overview)
4. [Message Types](#4-message-types)
   - 4.1. [Change Messages](#41-change-messages)
   - 4.2. [Control Messages](#42-control-messages)
5. [Message Format](#5-message-format)
   - 5.1. [Change Message Structure](#51-change-message-structure)
   - 5.2. [Control Message Structure](#52-control-message-structure)
6. [State Materialization](#6-state-materialization)
7. [Schema Validation](#7-schema-validation)
8. [Use Cases](#8-use-cases)
9. [Security Considerations](#9-security-considerations)
10. [IANA Considerations](#10-iana-considerations)
11. [References](#11-references)

---

## 1. Introduction

The Durable Streams State Protocol extends the Durable Streams Protocol [PROTOCOL] by defining a standard message format for state synchronization. While the base protocol provides byte-level stream operations, this extension adds semantic meaning to messages, enabling clients to materialize and query state from change events.

The protocol is designed to be:

- **Composable**: A building block that works with any transport layer (durable streams, WebSockets, Server-Sent Events)
- **Type-safe**: Supports multi-type streams with discriminated unions
- **Decoupled**: Separates event processing from persistence, allowing flexible storage backends
- **Schema-agnostic**: Uses Standard Schema [STANDARD-SCHEMA] for validation, supporting multiple schema libraries

This protocol enables applications to build real-time state synchronization systems including presence tracking, chat rooms, feature flags, collaborative editing, and more, all using a common change event vocabulary.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

**Change Message**: A message representing a state mutation (insert, update, or delete operation) on an entity identified by type and key.

**Control Message**: A message for stream management (snapshot boundaries, resets) separate from data changes.

**Entity Type**: A discriminator field in change messages that routes events to the correct collection or handler. Enables multi-type streams where different entity types coexist.

**Entity Key**: A unique identifier for an entity within a given type. Together with type, forms a composite key.

**Materialized State**: An in-memory or persistent view of state constructed by applying change events sequentially.

**Operation**: The type of change being applied: `insert` (create), `update` (modify), or `delete` (remove).

**Standard Schema**: A vendor-neutral schema format [STANDARD-SCHEMA] that enables validation with multiple schema libraries (Zod, Valibot, ArkType).

## 3. Protocol Overview

The State Protocol operates on streams created with `Content-Type: application/json` as specified in the base Durable Streams Protocol [PROTOCOL]. Messages are JSON objects that conform to one of two message types:

1. **Change Messages**: Represent state mutations (insert/update/delete)
2. **Control Messages**: Provide stream management signals

Clients append change messages to streams using the base protocol's append operation. When reading from streams, clients receive JSON arrays of messages (per Section 7.1 of [PROTOCOL]) and apply them sequentially to materialize state.

The protocol does not prescribe:

- How state is persisted (in-memory, IndexedDB, SQLite, etc.)
- How queries are executed (direct map lookups, database queries, etc.)
- How conflicts are resolved (last-write-wins, CRDTs, etc.)

These decisions are left to implementations, enabling flexibility while providing a common event format.

## 4. Message Types

### 4.1. Change Messages

Change messages represent state mutations. They **MUST** contain:

- `type` (string): Entity type discriminator
- `key` (string): Entity identifier
- `value` (any JSON value): The new value for the entity
- `headers` (object): Operation metadata

Change messages **MAY** include:

- `old_value` (any JSON value): Previous value, useful for conflict detection or audit logging

The `headers` object **MUST** contain:

- `operation` (string): One of `"insert"`, `"update"`, or `"delete"`

The `headers` object **MAY** contain:

- `txid` (string): Transaction identifier for grouping related changes
- `timestamp` (string): RFC 3339 timestamp indicating when the change occurred

#### 4.1.1. Insert Operation

Insert operations create new entities. The `value` field **MUST** be present and contain the entity data. The `old_value` field **SHOULD NOT** be present for insert operations.

**Example:**

```json
{
  "type": "user",
  "key": "user:123",
  "value": {
    "name": "Alice",
    "email": "alice@example.com"
  },
  "headers": {
    "operation": "insert",
    "timestamp": "2025-01-15T10:30:00Z"
  }
}
```

#### 4.1.2. Update Operation

Update operations modify existing entities. The `value` field **MUST** be present and contain the new entity data. The `old_value` field **MAY** be present to enable conflict detection.

**Example:**

```json
{
  "type": "user",
  "key": "user:123",
  "value": {
    "name": "Alice",
    "email": "alice.new@example.com"
  },
  "old_value": {
    "name": "Alice",
    "email": "alice@example.com"
  },
  "headers": {
    "operation": "update",
    "timestamp": "2025-01-15T10:35:00Z"
  }
}
```

#### 4.1.3. Delete Operation

Delete operations remove entities. The `value` field **MAY** be present (typically `null` or omitted) for delete operations. The `old_value` field **MAY** be present to preserve the deleted entity's data.

**Example:**

```json
{
  "type": "user",
  "key": "user:123",
  "value": null,
  "old_value": {
    "name": "Alice",
    "email": "alice.new@example.com"
  },
  "headers": {
    "operation": "delete",
    "timestamp": "2025-01-15T10:40:00Z"
  }
}
```

### 4.2. Control Messages

Control messages provide stream management signals separate from data changes. They **MUST** contain:

- `headers` (object): Control metadata

The `headers` object **MUST** contain:

- `control` (string): One of `"snapshot-start"`, `"snapshot-end"`, or `"reset"`

The `headers` object **MAY** contain:

- `offset` (string): Stream offset associated with the control event

#### 4.2.1. Snapshot Boundaries

The `snapshot-start` and `snapshot-end` control messages delimit snapshot boundaries. Servers **MAY** emit these to indicate that a sequence of change messages represents a complete snapshot of state at a point in time.

**Example:**

```json
{
  "headers": {
    "control": "snapshot-start",
    "offset": "123456_000"
  }
}
```

```json
{
  "headers": {
    "control": "snapshot-end",
    "offset": "123456_789"
  }
}
```

#### 4.2.2. Reset Control

The `reset` control message signals that clients **SHOULD** clear their materialized state and restart from the indicated offset. This enables servers to signal state resets or schema migrations.

**Example:**

```json
{
  "headers": {
    "control": "reset",
    "offset": "123456_000"
  }
}
```

## 5. Message Format

### 5.1. Change Message Structure

Change messages **MUST** be valid JSON objects with the following structure:

```json
{
  "type": "<entity-type>",
  "key": "<entity-key>",
  "value": <any-json-value>,
  "old_value": <any-json-value>,  // optional
  "headers": {
    "operation": "insert" | "update" | "delete",
    "txid": "<transaction-id>",  // optional
    "timestamp": "<rfc3339-timestamp>"  // optional
  }
}
```

**Field Requirements:**

- `type`: **MUST** be a non-empty string
- `key`: **MUST** be a non-empty string
- `value`: **MUST** be a valid JSON value (string, number, boolean, null, array, or object)
- `old_value`: **MAY** be present; if present, **MUST** be a valid JSON value
- `headers.operation`: **MUST** be one of `"insert"`, `"update"`, or `"delete"`
- `headers.txid`: **MAY** be present; if present, **MUST** be a non-empty string
- `headers.timestamp`: **MAY** be present; if present, **MUST** be a valid RFC 3339 timestamp

### 5.2. Control Message Structure

Control messages **MUST** be valid JSON objects with the following structure:

```json
{
  "headers": {
    "control": "snapshot-start" | "snapshot-end" | "reset",
    "offset": "<stream-offset>"  // optional
  }
}
```

**Field Requirements:**

- `headers.control`: **MUST** be one of `"snapshot-start"`, `"snapshot-end"`, or `"reset"`
- `headers.offset`: **MAY** be present; if present, **MUST** be a valid stream offset string

## 6. State Materialization

Clients materialize state by applying change messages sequentially in stream order. The materialization process **MUST**:

1. Process messages in the order they appear in the stream
2. For change messages:
   - Apply `insert` operations by storing the entity at `type`/`key`
   - Apply `update` operations by replacing the entity at `type`/`key`
   - Apply `delete` operations by removing the entity at `type`/`key`
3. For control messages:
   - Handle control signals according to application logic (e.g., clear state on `reset`)

The protocol does not prescribe how state is stored. Implementations **MAY** use:

- In-memory maps (for simple cases)
- IndexedDB (for browser persistence)
- SQLite (for local databases)
- TanStack DB collections (for query interfaces)
- Custom storage backends

**Example Materialization:**

Given the following change messages:

```json
[
  {
    "type": "user",
    "key": "1",
    "value": { "name": "Alice" },
    "headers": { "operation": "insert" }
  },
  {
    "type": "user",
    "key": "2",
    "value": { "name": "Bob" },
    "headers": { "operation": "insert" }
  },
  {
    "type": "user",
    "key": "1",
    "value": { "name": "Alice Smith" },
    "headers": { "operation": "update" }
  }
]
```

The materialized state after processing would be:

```
type: "user"
  key: "1" -> { "name": "Alice Smith" }
  key: "2" -> { "name": "Bob" }
```

## 7. Schema Validation

Implementations **MAY** validate change message values using Standard Schema [STANDARD-SCHEMA]. Standard Schema provides a vendor-neutral format that works with multiple schema libraries (Zod, Valibot, ArkType).

When schema validation is enabled:

- Change messages **SHOULD** be validated against the schema for their entity type before materialization
- Invalid messages **MAY** be rejected or logged according to implementation policy
- Schema validation **SHOULD NOT** block stream processing for other entity types

The protocol does not require schema validation, but implementations **SHOULD** provide validation capabilities for production use.

## 8. Use Cases

The State Protocol enables several common patterns:

### 8.1. Key/Value Store

Simple synced configuration with optimistic updates:

```json
{
  "type": "config",
  "key": "theme",
  "value": "dark",
  "headers": { "operation": "insert" }
}
```

### 8.2. Presence Tracking

Real-time online status with heartbeat semantics:

```json
{
  "type": "presence",
  "key": "user:123",
  "value": { "status": "online", "lastSeen": 1705312200000 },
  "headers": { "operation": "update" }
}
```

### 8.3. Multi-Type Streams

Chat rooms with users, messages, reactions, and receipts:

```json
[
  {
    "type": "user",
    "key": "user:123",
    "value": { "name": "Alice" },
    "headers": { "operation": "insert" }
  },
  {
    "type": "message",
    "key": "msg:456",
    "value": { "userId": "user:123", "text": "Hello!" },
    "headers": { "operation": "insert" }
  },
  {
    "type": "reaction",
    "key": "reaction:789",
    "value": { "messageId": "msg:456", "emoji": "👍" },
    "headers": { "operation": "insert" }
  }
]
```

### 8.4. Feature Flags

Real-time configuration propagation:

```json
{
  "type": "flag",
  "key": "new-editor",
  "value": {
    "enabled": true,
    "rollout": { "type": "percentage", "value": 50 }
  },
  "headers": { "operation": "update" }
}
```

## 9. Security Considerations

### 9.1. Message Validation

Clients **MUST** validate that received messages conform to the message format specified in this document. Malformed messages **SHOULD** be rejected to prevent injection attacks.

### 9.2. Schema Validation

When schema validation is enabled, implementations **MUST** validate change message values before materialization. Invalid values **SHOULD** be rejected to prevent type confusion attacks.

### 9.3. Untrusted Content

As specified in the base protocol [PROTOCOL], clients **MUST** treat stream contents as untrusted input. This applies to both the message structure and the values within change messages.

### 9.4. Type and Key Validation

Implementations **SHOULD** validate that `type` and `key` fields contain only expected values to prevent injection of unauthorized entity types or keys.

### 9.5. Transaction Identifiers

The `txid` field is opaque to clients. Servers **MAY** use transaction identifiers for grouping related changes, but clients **MUST NOT** rely on transaction semantics unless explicitly documented by the server.

## 10. IANA Considerations

This document does not require any IANA registrations. The protocol uses JSON message formats and operates within the context of the Durable Streams Protocol [PROTOCOL], which defines the necessary HTTP headers and content types.

## 11. References

### 11.1. Normative References

**[PROTOCOL]**  
Durable Streams Protocol. ElectricSQL, 2025.  
<https://github.com/electric-sql/durable-streams/blob/main/PROTOCOL.md>

**[RFC2119]**  
Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

**[RFC3339]**  
Klyne, G. and C. Newman, "Date and Time on the Internet: Timestamps", RFC 3339, DOI 10.17487/RFC3339, July 2002, <https://www.rfc-editor.org/info/rfc3339>.

**[RFC8174]**  
Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.

**[STANDARD-SCHEMA]**  
Standard Schema Specification.  
<https://github.com/standard-schema/spec>

### 11.2. Informative References

**[JSON-SCHEMA]**  
Wright, A., Andrews, H., and B. Hutton, "JSON Schema: A Media Type for Describing JSON Documents", draft-wright-json-schema-00 (work in progress).

---

**Full Copyright Statement**

Copyright (c) 2025 ElectricSQL

This document and the information contained herein are provided on an "AS IS" basis. ElectricSQL disclaims all warranties, express or implied, including but not limited to any warranty that the use of the information herein will not infringe any rights or any implied warranties of merchantability or fitness for a particular purpose.
