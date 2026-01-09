//! Retry and backoff configuration with jitter support.

use rand::Rng;
use std::time::Duration;

/// Retry/backoff configuration.
///
/// **Important**: Retries are only safe for idempotent operations:
/// - GET/HEAD requests: Always safe to retry
/// - POST append with IdempotentProducer: Safe (has Producer-Id/Epoch/Seq)
/// - Plain POST append: NOT safe to retry (can cause duplicates)
#[derive(Clone, Debug)]
pub struct RetryConfig {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub multiplier: f64,
    pub max_retries: u32,
    /// Jitter mode for backoff delays (prevents thundering herd)
    pub jitter: JitterMode,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(60),
            multiplier: 1.3,
            max_retries: 10,
            jitter: JitterMode::Full,
        }
    }
}

impl RetryConfig {
    /// Create a new retry config with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Set initial backoff delay
    pub fn with_initial_backoff(mut self, delay: Duration) -> Self {
        self.initial_backoff = delay;
        self
    }

    /// Set maximum backoff delay
    pub fn with_max_backoff(mut self, delay: Duration) -> Self {
        self.max_backoff = delay;
        self
    }

    /// Set backoff multiplier
    pub fn with_multiplier(mut self, multiplier: f64) -> Self {
        self.multiplier = multiplier;
        self
    }

    /// Set maximum retry attempts
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    /// Set jitter mode
    pub fn with_jitter(mut self, jitter: JitterMode) -> Self {
        self.jitter = jitter;
        self
    }

    /// Calculate the next backoff delay with jitter
    pub fn next_backoff(&self, attempt: u32, current_delay: Duration) -> Duration {
        let base_delay = if attempt == 0 {
            self.initial_backoff
        } else {
            let multiplied = current_delay.as_secs_f64() * self.multiplier;
            Duration::from_secs_f64(multiplied.min(self.max_backoff.as_secs_f64()))
        };

        apply_jitter(base_delay, &self.jitter)
    }

    /// Check if we should retry based on attempt count
    pub fn should_retry(&self, attempt: u32) -> bool {
        attempt < self.max_retries
    }
}

/// Jitter mode for retry backoff (following AWS SDK patterns).
#[derive(Clone, Debug, Default)]
pub enum JitterMode {
    /// No jitter - use exact backoff delay
    None,
    /// Full jitter: random delay between 0 and calculated backoff
    #[default]
    Full,
    /// Equal jitter: half fixed + half random
    Equal,
    /// Decorrelated jitter (AWS recommended)
    Decorrelated,
}

/// Apply jitter to a backoff delay.
pub fn apply_jitter(delay: Duration, mode: &JitterMode) -> Duration {
    let mut rng = rand::thread_rng();

    match mode {
        JitterMode::None => delay,
        JitterMode::Full => {
            // Random between 0 and delay
            Duration::from_secs_f64(rng.gen::<f64>() * delay.as_secs_f64())
        }
        JitterMode::Equal => {
            // Half fixed + half random
            let half = delay.as_secs_f64() / 2.0;
            Duration::from_secs_f64(half + rng.gen::<f64>() * half)
        }
        JitterMode::Decorrelated => {
            // AWS-style: min(max_delay, random_between(base, delay * 3))
            let base = delay.as_secs_f64() / 3.0;
            let upper = delay.as_secs_f64() * 3.0;
            Duration::from_secs_f64(base + rng.gen::<f64>() * (upper - base))
        }
    }
}
