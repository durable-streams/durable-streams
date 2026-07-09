/**
 * Idempotent-producer validation (Kafka-style).
 *
 * Ported from the Durable Streams reference server
 * (packages/server/src/store.ts `validateProducer`, Apache-2.0,
 * Durable Stream contributors), extracted as a pure function.
 *
 * Validation does NOT mutate producer state: on `accepted` the caller
 * commits `proposedState` only after the append succeeds, so a failed
 * append (e.g. invalid JSON) never advances the producer.
 */

export interface ProducerState {
  epoch: number;
  lastSeq: number;
  lastUpdated: number;
}

export type ProducerValidationResult =
  | {
      status: "accepted";
      isNew: boolean;
      producerId: string;
      proposedState: ProducerState;
    }
  | { status: "duplicate"; lastSeq: number }
  | { status: "stale_epoch"; currentEpoch: number }
  | { status: "invalid_epoch_seq" }
  | { status: "sequence_gap"; expectedSeq: number; receivedSeq: number }
  | { status: "stream_closed" };

export function validateProducer(
  state: ProducerState | undefined,
  producerId: string,
  epoch: number,
  seq: number,
  now: number,
): ProducerValidationResult {
  // New producer - accept only if seq is 0
  if (!state) {
    if (seq !== 0) {
      return { status: "sequence_gap", expectedSeq: 0, receivedSeq: seq };
    }
    return {
      status: "accepted",
      isNew: true,
      producerId,
      proposedState: { epoch, lastSeq: 0, lastUpdated: now },
    };
  }

  // Epoch validation (client-declared, server-validated)
  if (epoch < state.epoch) {
    return { status: "stale_epoch", currentEpoch: state.epoch };
  }

  if (epoch > state.epoch) {
    // New epoch must start at seq=0
    if (seq !== 0) {
      return { status: "invalid_epoch_seq" };
    }
    return {
      status: "accepted",
      isNew: true,
      producerId,
      proposedState: { epoch, lastSeq: 0, lastUpdated: now },
    };
  }

  // Same epoch: sequence validation
  if (seq <= state.lastSeq) {
    return { status: "duplicate", lastSeq: state.lastSeq };
  }

  if (seq === state.lastSeq + 1) {
    return {
      status: "accepted",
      isNew: false,
      producerId,
      proposedState: { epoch, lastSeq: seq, lastUpdated: now },
    };
  }

  return {
    status: "sequence_gap",
    expectedSeq: state.lastSeq + 1,
    receivedSeq: seq,
  };
}
