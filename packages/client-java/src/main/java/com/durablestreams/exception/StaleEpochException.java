package com.durablestreams.exception;

/**
 * Thrown when an idempotent producer uses a stale epoch (403).
 */
public class StaleEpochException extends DurableStreamException {
    private final long currentEpoch;

    public StaleEpochException(long currentEpoch) {
        super("Stale epoch: current epoch is " + currentEpoch, 403, "STALE_EPOCH");
        this.currentEpoch = currentEpoch;
    }

    public long getCurrentEpoch() {
        return currentEpoch;
    }
}
