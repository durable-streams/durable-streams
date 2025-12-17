/**
 * Example protocol implementations.
 *
 * These examples demonstrate how to build protocols on top of durable streams
 * for common use cases.
 */

// State protocol - key-value state with compaction
export {
  createStateProtocol,
  materializeMessages,
  materializeState,
  type StateChange,
  type SnapshotEvent,
  type StateProtocolOptions,
} from "./state-protocol"

// SSE proxy protocol - make external SSE sources durable
export {
  createSSEProxyProtocol,
  type SSESourceConfig,
  type SSESourceStatus,
  type SSEProxyProtocolOptions,
} from "./sse-proxy-protocol"

// CRDT protocol - collaborative document sync (Yjs/Automerge)
export {
  createCRDTProtocol,
  type DocumentMetadata,
  type AwarenessUpdate,
  type CRDTProtocolOptions,
} from "./crdt-protocol"
