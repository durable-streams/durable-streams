//! Idempotent producer with exactly-once semantics.

use crate::error::{ProducerError, StreamError};
use crate::stream::{
    DurableStream, HEADER_CONTENT_TYPE, HEADER_PRODUCER_EPOCH, HEADER_PRODUCER_EXPECTED_SEQ,
    HEADER_PRODUCER_ID, HEADER_PRODUCER_SEQ, HEADER_STREAM_OFFSET,
};
use crate::types::Offset;
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio::time::sleep;

/// Receipt from an acknowledged append operation.
#[derive(Debug, Clone)]
pub struct AppendReceipt {
    /// The offset after this message was appended.
    pub next_offset: Offset,
    /// Whether this was a duplicate (idempotent success, data already existed).
    pub duplicate: bool,
}

/// Type alias for error callback function.
pub type OnErrorCallback = Arc<dyn Fn(ProducerError) + Send + Sync>;

/// Builder for configuring an idempotent producer.
#[must_use = "builders do nothing unless you call .build()"]
pub struct ProducerBuilder {
    stream: DurableStream,
    producer_id: String,
    epoch: u64,
    auto_claim: bool,
    max_batch_bytes: usize,
    linger: Duration,
    max_in_flight: usize,
    content_type: Option<String>,
    on_error: Option<OnErrorCallback>,
}

impl ProducerBuilder {
    pub(crate) fn new(stream: DurableStream, producer_id: String) -> Self {
        Self {
            stream,
            producer_id,
            epoch: 0,
            auto_claim: false,
            max_batch_bytes: 1024 * 1024,
            linger: Duration::from_millis(5),
            max_in_flight: 5,
            content_type: None,
            on_error: None,
        }
    }

    /// Set the starting epoch.
    pub fn epoch(mut self, epoch: u64) -> Self {
        self.epoch = epoch;
        self
    }

    /// Enable auto-claim on stale epoch.
    pub fn auto_claim(mut self, enabled: bool) -> Self {
        self.auto_claim = enabled;
        self
    }

    /// Set maximum batch size in bytes.
    pub fn max_batch_bytes(mut self, bytes: usize) -> Self {
        self.max_batch_bytes = bytes;
        self
    }

    /// Set linger time before sending a batch.
    pub fn linger(mut self, duration: Duration) -> Self {
        self.linger = duration;
        self
    }

    /// Set maximum in-flight batches.
    pub fn max_in_flight(mut self, count: usize) -> Self {
        self.max_in_flight = count;
        self
    }

    /// Set content type for appends.
    pub fn content_type(mut self, ct: impl Into<String>) -> Self {
        self.content_type = Some(ct.into());
        self
    }

    /// Set error callback for batch failures.
    ///
    /// Following Kafka semantics, errors from batch sends are reported via this
    /// callback rather than through `flush()`. This enables fire-and-forget
    /// usage while still allowing error handling when needed.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let producer = stream.producer("my-producer")
    ///     .on_error(|err| {
    ///         eprintln!("Batch failed: {}", err);
    ///     })
    ///     .build();
    /// ```
    pub fn on_error<F>(mut self, callback: F) -> Self
    where
        F: Fn(ProducerError) + Send + Sync + 'static,
    {
        self.on_error = Some(Arc::new(callback));
        self
    }

    /// Build the producer.
    pub fn build(self) -> Producer {
        let content_type = self.content_type.unwrap_or_else(|| {
            self.stream
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string())
        });

        let linger = self.linger;

        let producer = Producer {
            stream: self.stream,
            producer_id: self.producer_id,
            state: Arc::new(Mutex::new(ProducerState {
                epoch: self.epoch,
                next_seq: 0,
                pending_batch: Vec::with_capacity(1024),
                batch_bytes: 0,
                closed: false,
                epoch_claimed: !self.auto_claim,
                batch_started_at: None,
            })),
            config: Arc::new(ProducerConfig {
                auto_claim: self.auto_claim,
                max_batch_bytes: self.max_batch_bytes,
                linger,
                max_in_flight: self.max_in_flight,
                content_type,
                on_error: self.on_error,
            }),
            in_flight: Arc::new(AtomicUsize::new(0)),
            seq_state: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        };

        // Spawn linger task if linger > 0
        if linger > Duration::ZERO {
            let producer_clone = producer.clone();
            tokio::spawn(async move {
                producer_clone.linger_task().await;
            });
        }

        producer
    }
}

struct ProducerConfig {
    auto_claim: bool,
    max_batch_bytes: usize,
    linger: Duration,
    max_in_flight: usize,
    content_type: String,
    on_error: Option<OnErrorCallback>,
}

struct ProducerState {
    epoch: u64,
    next_seq: u64,
    pending_batch: Vec<PendingEntry>,
    batch_bytes: usize,
    closed: bool,
    epoch_claimed: bool,
    /// When the first item was added to the current pending batch
    batch_started_at: Option<Instant>,
}

struct PendingEntry {
    data: Bytes,
    #[cfg(feature = "json")]
    json_data: Option<serde_json::Value>,
}

/// Idempotent producer with exactly-once semantics.
///
/// Provides high-throughput, fire-and-forget writes with automatic batching,
/// pipelining, and exactly-once delivery guarantees via producer ID, epoch,
/// and sequence numbers.
#[derive(Clone)]
pub struct Producer {
    stream: DurableStream,
    producer_id: String,
    state: Arc<Mutex<ProducerState>>,
    config: Arc<ProducerConfig>,
    in_flight: Arc<AtomicUsize>,
    seq_state: Arc<tokio::sync::Mutex<HashMap<u64, SeqState>>>,
}

#[derive(Default)]
struct SeqState {
    resolved: bool,
    error: Option<String>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}

impl Producer {
    /// Append data (fire-and-forget, batched internally).
    ///
    /// Returns immediately - data is queued for sending.
    /// Use `flush()` to wait for all data to be written.
    ///
    /// # Silent Failures
    ///
    /// This method silently ignores appends if the producer is closed.
    /// Network and server errors during batch sending are not surfaced
    /// per-append; use `flush()` to ensure data is durably written.
    #[inline]
    pub fn append(&self, data: impl Into<Bytes>) {
        let data = data.into();
        let data_len = data.len();

        let mut state = self.state.lock();
        if state.closed {
            return; // Silently ignore if closed
        }

        // Track when batch started (for linger timer)
        if state.pending_batch.is_empty() {
            state.batch_started_at = Some(Instant::now());
        }

        state.pending_batch.push(PendingEntry {
            data,
            #[cfg(feature = "json")]
            json_data: None,
        });
        state.batch_bytes += data_len;

        if state.batch_bytes >= self.config.max_batch_bytes {
            self.send_batch_locked(&mut state);
        }
    }

    /// Append JSON data (fire-and-forget).
    ///
    /// # Silent Failures
    ///
    /// This method silently ignores:
    /// - Appends if the producer is closed
    /// - JSON serialization errors
    ///
    /// Network and server errors during batch sending are not surfaced
    /// per-append; use `flush()` to ensure data is durably written.
    #[cfg(feature = "json")]
    #[inline]
    pub fn append_json<T: serde::Serialize>(&self, data: &T) {
        // Convert to Value first (avoids serialize -> parse -> unwrap)
        let json_value = match serde_json::to_value(data) {
            Ok(v) => v,
            Err(_) => return, // Silently ignore serialization errors
        };

        // Serialize to bytes for size tracking
        let json_bytes = match serde_json::to_vec(&json_value) {
            Ok(b) => b,
            Err(_) => return, // Shouldn't happen if to_value succeeded
        };

        let mut state = self.state.lock();
        if state.closed {
            return;
        }

        // Track when batch started (for linger timer)
        if state.pending_batch.is_empty() {
            state.batch_started_at = Some(Instant::now());
        }

        let len = json_bytes.len();
        state.pending_batch.push(PendingEntry {
            data: Bytes::from(json_bytes),
            json_data: Some(json_value),
        });
        state.batch_bytes += len;

        if state.batch_bytes >= self.config.max_batch_bytes {
            self.send_batch_locked(&mut state);
        }
    }

    /// Flush all pending data and wait for all in-flight batches to complete.
    ///
    /// This method blocks until all buffered records have been sent and acknowledged.
    /// Following Kafka semantics, errors are reported via the `on_error` callback
    /// (if configured), not through the return value of this method.
    ///
    /// Call this before shutdown to ensure all messages have been sent.
    pub async fn flush(&self) -> Result<(), ProducerError> {
        // Keep sending batches until everything is flushed
        loop {
            let has_pending = {
                let mut state = self.state.lock();
                if !state.pending_batch.is_empty() {
                    self.send_batch_locked(&mut state);
                }
                !state.pending_batch.is_empty()
            };

            let in_flight = self.in_flight.load(Ordering::Acquire);

            // Done when no pending data and nothing in flight
            if !has_pending && in_flight == 0 {
                break;
            }

            // Yield to let in-flight requests complete
            tokio::task::yield_now().await;
        }

        Ok(())
    }

    /// Close the producer gracefully.
    pub async fn close(&self) -> Result<(), ProducerError> {
        self.flush().await?;

        let mut state = self.state.lock();
        state.closed = true;

        Ok(())
    }

    /// Get the current epoch.
    pub fn epoch(&self) -> u64 {
        self.state.lock().epoch
    }

    /// Get the next sequence number.
    pub fn next_seq(&self) -> u64 {
        self.state.lock().next_seq
    }

    /// Background task that sends batches after linger duration.
    async fn linger_task(&self) {
        let linger = self.config.linger;

        loop {
            // Sleep for linger duration
            sleep(linger).await;

            // Check if we should stop
            let should_send = {
                let state = self.state.lock();
                if state.closed {
                    return; // Stop the task
                }

                // Check if there's a pending batch that's old enough
                if let Some(started_at) = state.batch_started_at {
                    started_at.elapsed() >= linger
                } else {
                    false
                }
            };

            // Send the batch if needed (outside the lock)
            if should_send {
                let mut state = self.state.lock();
                if !state.pending_batch.is_empty() {
                    self.send_batch_locked(&mut state);
                }
            }
        }
    }

    /// Send the current batch in a background task.
    ///
    /// # Safety Invariant
    ///
    /// This method is called while holding the mutex lock on `ProducerState`.
    /// It extracts data from the state (cloning batch contents), then spawns
    /// a background task with the cloned data. The lock is released when this
    /// method returns, before any async work occurs. This is safe because:
    /// - We don't await while holding the lock
    /// - The spawned task receives cloned/owned data, not references to locked state
    /// - The mutex is sync-only (parking_lot), not held across await points
    fn send_batch_locked(&self, state: &mut ProducerState) {
        if state.pending_batch.is_empty() {
            return;
        }

        // Check in-flight limit (atomic read - no lock needed)
        let in_flight = self.in_flight.load(Ordering::Acquire);
        if in_flight >= self.config.max_in_flight {
            return;
        }

        // Check epoch claim
        if self.config.auto_claim && !state.epoch_claimed && in_flight > 0 {
            return;
        }

        // Take the batch
        let batch: Vec<_> = state.pending_batch.drain(..).collect();
        let seq = state.next_seq;
        let epoch = state.epoch;

        state.next_seq += 1;
        state.batch_bytes = 0;
        state.batch_started_at = None;

        // Increment in-flight (atomic - no lock needed)
        self.in_flight.fetch_add(1, Ordering::AcqRel);

        // Send in background
        let stream = self.stream.clone();
        let producer_id = self.producer_id.clone();
        let config = self.config.clone();
        let in_flight_counter = self.in_flight.clone();
        let state_arc = self.state.clone();
        let seq_state = self.seq_state.clone();

        tokio::spawn(async move {
            let result =
                do_send_batch(&stream, &producer_id, &config.content_type, batch, seq, epoch, config.auto_claim, &state_arc)
                    .await;

            // Update epoch if claimed
            if result.is_ok() {
                let mut state = state_arc.lock();
                if !state.epoch_claimed {
                    state.epoch_claimed = true;
                }
            }

            // Call on_error callback if configured and error occurred
            if let Err(ref e) = result {
                if let Some(ref callback) = config.on_error {
                    callback(e.clone());
                }
            }

            // Signal completion
            {
                let mut seq_map = seq_state.lock().await;
                let entry = seq_map.entry(seq).or_default();
                entry.resolved = true;
                if let Err(e) = &result {
                    entry.error = Some(e.to_string());
                }
                for waiter in entry.waiters.drain(..) {
                    let _ = waiter.send(result.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                }
            }

            // Decrement in-flight (atomic - no lock needed)
            in_flight_counter.fetch_sub(1, Ordering::AcqRel);
        });
    }
}

async fn do_send_batch(
    stream: &DurableStream,
    producer_id: &str,
    content_type: &str,
    batch: Vec<PendingEntry>,
    seq: u64,
    epoch: u64,
    auto_claim: bool,
    state: &Arc<Mutex<ProducerState>>,
) -> Result<AppendReceipt, ProducerError> {
    do_send_batch_with_retry(stream, producer_id, content_type, batch, seq, epoch, auto_claim, state, 0).await
}

async fn do_send_batch_with_retry(
    stream: &DurableStream,
    producer_id: &str,
    content_type: &str,
    batch: Vec<PendingEntry>,
    seq: u64,
    epoch: u64,
    auto_claim: bool,
    state: &Arc<Mutex<ProducerState>>,
    retry_count: u32,
) -> Result<AppendReceipt, ProducerError> {
    const MAX_409_RETRIES: u32 = 10;

    let is_json = content_type.to_lowercase().contains("application/json");

    // Build body
    let body = if is_json {
        #[cfg(feature = "json")]
        {
            // Check for mixed append types (some with json_data, some without)
            let json_count = batch.iter().filter(|e| e.json_data.is_some()).count();
            let raw_count = batch.len() - json_count;

            if json_count > 0 && raw_count > 0 {
                // Mixed types in a JSON batch - this would silently drop entries
                return Err(ProducerError::MixedAppendTypes);
            }

            if json_count > 0 {
                // All entries have json_data - wrap in array for JSON batching
                let values: Vec<serde_json::Value> = batch
                    .iter()
                    .filter_map(|e| e.json_data.clone())
                    .collect();
                serde_json::to_vec(&values).unwrap_or_default()
            } else {
                // All raw bytes - concatenate
                batch
                    .iter()
                    .flat_map(|e| e.data.iter().copied())
                    .collect::<Vec<u8>>()
            }
        }
        #[cfg(not(feature = "json"))]
        {
            batch
                .iter()
                .flat_map(|e| e.data.iter().copied())
                .collect::<Vec<u8>>()
        }
    } else {
        batch
            .iter()
            .flat_map(|e| e.data.iter().copied())
            .collect::<Vec<u8>>()
    };

    let resp = stream
        .client
        .inner
        .post(&stream.url)
        .header(HEADER_CONTENT_TYPE, content_type)
        .header(HEADER_PRODUCER_ID, producer_id)
        .header(HEADER_PRODUCER_EPOCH, epoch.to_string())
        .header(HEADER_PRODUCER_SEQ, seq.to_string())
        .body(body)
        .send()
        .await?;

    let status = resp.status().as_u16();

    match status {
        200 => {
            let offset = resp
                .headers()
                .get(HEADER_STREAM_OFFSET)
                .and_then(|v| v.to_str().ok())
                .map(Offset::parse)
                .unwrap_or(Offset::Beginning);

            Ok(AppendReceipt {
                next_offset: offset,
                duplicate: false,
            })
        }
        204 => {
            // Duplicate - idempotent success
            Ok(AppendReceipt {
                next_offset: Offset::Beginning,
                duplicate: true,
            })
        }
        403 => {
            // Stale epoch
            let server_epoch = resp
                .headers()
                .get(HEADER_PRODUCER_EPOCH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(epoch);

            if auto_claim {
                // Auto-claim: retry with epoch+1
                let new_epoch = server_epoch + 1;
                {
                    let mut s = state.lock();
                    s.epoch = new_epoch;
                    s.next_seq = 1; // This batch uses seq 0
                    s.epoch_claimed = false; // Reset so pipelining waits for seq 0 to succeed
                }
                // Retry with new epoch
                return Box::pin(do_send_batch_with_retry(
                    stream,
                    producer_id,
                    content_type,
                    batch,
                    0,
                    new_epoch,
                    auto_claim,
                    state,
                    0, // Reset retry count for new epoch
                ))
                .await;
            }

            Err(ProducerError::StaleEpoch {
                server_epoch,
                our_epoch: epoch,
            })
        }
        409 => {
            // Sequence gap - this can happen when requests arrive out of order
            // Retry with exponential backoff to let earlier sequences complete
            if retry_count < MAX_409_RETRIES {
                // Wait before retrying - use exponential backoff
                let delay_ms = 10 * (1 << retry_count.min(6)); // 10ms, 20ms, 40ms, ... up to 640ms
                sleep(Duration::from_millis(delay_ms)).await;

                return Box::pin(do_send_batch_with_retry(
                    stream,
                    producer_id,
                    content_type,
                    batch,
                    seq,
                    epoch,
                    auto_claim,
                    state,
                    retry_count + 1,
                ))
                .await;
            }

            // Give up after max retries
            let expected = resp
                .headers()
                .get(HEADER_PRODUCER_EXPECTED_SEQ)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);

            Err(ProducerError::SequenceGap {
                expected,
                received: seq,
            })
        }
        _ => Err(ProducerError::Stream {
            message: StreamError::from_status(status, &stream.url).to_string(),
        }),
    }
}
