package com.durablestreams.exception;

/**
 * Thrown when a sequence conflict occurs (409 with Stream-Seq regression).
 */
public class SequenceConflictException extends DurableStreamException {
    private final String expectedSeq;
    private final String receivedSeq;

    public SequenceConflictException(String expectedSeq, String receivedSeq) {
        super("Sequence conflict: expected " + expectedSeq + ", received " + receivedSeq,
              409, "SEQUENCE_CONFLICT");
        this.expectedSeq = expectedSeq;
        this.receivedSeq = receivedSeq;
    }

    public String getExpectedSeq() {
        return expectedSeq;
    }

    public String getReceivedSeq() {
        return receivedSeq;
    }
}
