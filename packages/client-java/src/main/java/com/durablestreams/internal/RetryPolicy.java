package com.durablestreams.internal;

import java.time.Duration;
import java.util.Set;

/**
 * Configuration for retry behavior on transient errors.
 */
public final class RetryPolicy {
    private final int maxRetries;
    private final Duration initialDelay;
    private final Duration maxDelay;
    private final double multiplier;
    private final Set<Integer> retryableStatuses;

    public RetryPolicy(int maxRetries, Duration initialDelay, Duration maxDelay,
                       double multiplier, Set<Integer> retryableStatuses) {
        this.maxRetries = maxRetries;
        this.initialDelay = initialDelay;
        this.maxDelay = maxDelay;
        this.multiplier = multiplier;
        // Defensive copy - Set.copyOf creates an unmodifiable copy
        this.retryableStatuses = retryableStatuses != null ? Set.copyOf(retryableStatuses) : Set.of();
    }

    /**
     * Default retry policy: 3 retries, 100ms initial, 30s max, 2x backoff.
     * Retries on 429 and 5xx status codes.
     */
    public static RetryPolicy defaults() {
        return new RetryPolicy(
                3,
                Duration.ofMillis(100),
                Duration.ofSeconds(30),
                2.0,
                Set.of(429, 500, 502, 503, 504)
        );
    }

    /**
     * No retries policy.
     */
    public static RetryPolicy none() {
        return new RetryPolicy(0, Duration.ZERO, Duration.ZERO, 1.0, Set.of());
    }

    public static Builder builder() {
        return new Builder();
    }

    public int getMaxRetries() {
        return maxRetries;
    }

    public Duration getInitialDelay() {
        return initialDelay;
    }

    public Duration getMaxDelay() {
        return maxDelay;
    }

    public double getMultiplier() {
        return multiplier;
    }

    public boolean shouldRetry(int statusCode, int attempt) {
        if (attempt >= maxRetries) return false;
        return retryableStatuses.contains(statusCode) ||
               (statusCode >= 500 && statusCode < 600);
    }

    public Duration getDelay(int attempt) {
        double delay = initialDelay.toMillis() * Math.pow(multiplier, attempt);
        return Duration.ofMillis(Math.min((long) delay, maxDelay.toMillis()));
    }

    public static final class Builder {
        private int maxRetries = 3;
        private Duration initialDelay = Duration.ofMillis(100);
        private Duration maxDelay = Duration.ofSeconds(30);
        private double multiplier = 2.0;
        private Set<Integer> retryableStatuses = Set.of(429, 500, 502, 503, 504);

        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        public Builder initialDelay(Duration initialDelay) {
            this.initialDelay = initialDelay;
            return this;
        }

        public Builder maxDelay(Duration maxDelay) {
            this.maxDelay = maxDelay;
            return this;
        }

        public Builder multiplier(double multiplier) {
            this.multiplier = multiplier;
            return this;
        }

        public Builder retryableStatuses(Set<Integer> statuses) {
            this.retryableStatuses = statuses;
            return this;
        }

        public RetryPolicy build() {
            return new RetryPolicy(maxRetries, initialDelay, maxDelay, multiplier, retryableStatuses);
        }
    }
}
