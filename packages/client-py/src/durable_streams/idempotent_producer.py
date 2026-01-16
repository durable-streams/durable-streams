"""
IdempotentProducer - Fire-and-forget producer with exactly-once write semantics.

Implements Kafka-style idempotent producer pattern with:
- Client-provided producer IDs (zero RTT overhead)
- Client-declared epochs, server-validated fencing
- Per-batch sequence numbers for deduplication
- Automatic batching and pipelining for throughput
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from durable_streams._errors import DurableStreamError, FetchError
from durable_streams._types import Offset

# Producer header constants
PRODUCER_ID_HEADER = "Producer-Id"
PRODUCER_EPOCH_HEADER = "Producer-Epoch"
PRODUCER_SEQ_HEADER = "Producer-Seq"
PRODUCER_EXPECTED_SEQ_HEADER = "Producer-Expected-Seq"
PRODUCER_RECEIVED_SEQ_HEADER = "Producer-Received-Seq"
STREAM_NEXT_OFFSET_HEADER = "Stream-Next-Offset"


class StaleEpochError(Exception):
    """Error thrown when a producer's epoch is stale (zombie fencing)."""

    def __init__(self, current_epoch: int) -> None:
        super().__init__(
            f"Producer epoch is stale. Current server epoch: {current_epoch}. "
            f"Call restart() or create a new producer with a higher epoch."
        )
        self.current_epoch = current_epoch


class SequenceGapError(Exception):
    """
    Error thrown when an unrecoverable sequence gap is detected.

    With max_in_flight > 1, HTTP requests can arrive out of order at the server,
    causing temporary 409 responses. The client automatically handles these
    by waiting for earlier sequences to complete, then retrying.

    This error is only thrown when the gap cannot be resolved (e.g., the
    expected sequence is >= our sequence, indicating a true protocol violation).
    """

    def __init__(self, expected_seq: int, received_seq: int) -> None:
        super().__init__(
            f"Producer sequence gap: expected {expected_seq}, received {received_seq}"
        )
        self.expected_seq = expected_seq
        self.received_seq = received_seq


@dataclass
class IdempotentAppendResult:
    """Result of an idempotent append operation."""

    offset: Offset
    duplicate: bool


def _normalize_content_type(content_type: str | None) -> str:
    """Normalize content-type by extracting media type (before semicolon)."""
    if not content_type:
        return ""
    return content_type.split(";")[0].strip().lower()


@dataclass
class _PendingEntry:
    """Internal type for pending batch entries."""

    body: bytes
    # For JSON mode, store parsed data for proper array wrapping
    data: Any = None


@dataclass
class _SeqState:
    """Track completion state for a sequence (for 409 retry coordination)."""

    resolved: bool = False
    error: Exception | None = None
    waiters: list[asyncio.Future[None]] = field(
        default_factory=lambda: []  # type: ignore[misc]
    )


class IdempotentProducer:
    """
    An idempotent producer for exactly-once writes to a durable stream.

    Features:
    - Fire-and-forget: append() returns immediately, batches in background
    - Exactly-once: server deduplicates using (producerId, epoch, seq)
    - Batching: multiple appends batched into single HTTP request
    - Pipelining: up to max_in_flight concurrent batches
    - Zombie fencing: stale producers rejected via epoch validation

    Example:
        >>> async with httpx.AsyncClient() as client:
        ...     producer = IdempotentProducer(
        ...         url="https://example.com/stream",
        ...         producer_id="order-service-1",
        ...         client=client,
        ...         epoch=0,
        ...         auto_claim=True,
        ...     )
        ...
        ...     # Fire-and-forget writes (synchronous, returns immediately)
        ...     producer.append(b"message 1")
        ...     producer.append(b"message 2")
        ...
        ...     # Ensure all messages are delivered before shutdown
        ...     await producer.flush()
        ...     await producer.close()
    """

    def __init__(
        self,
        url: str,
        producer_id: str,
        *,
        client: httpx.AsyncClient | None = None,
        epoch: int = 0,
        auto_claim: bool = False,
        max_batch_bytes: int = 1024 * 1024,  # 1MB
        linger_ms: int = 5,
        max_in_flight: int = 5,
        content_type: str = "application/octet-stream",
        on_error: Any | None = None,  # Callable[[Exception], None]
    ) -> None:
        """
        Create an idempotent producer for a stream.

        Args:
            url: The full URL to the stream
            producer_id: Stable identifier for this producer (e.g., "order-service-1")
            client: Optional httpx.AsyncClient for connection reuse
            epoch: Starting epoch (default 0)
            auto_claim: If True, automatically claim higher epoch on 403
            max_batch_bytes: Maximum batch size in bytes before sending
            linger_ms: Maximum time to wait before sending a batch
            max_in_flight: Maximum concurrent batches
            content_type: Content type for appends
            on_error: Callback for batch errors

        Raises:
            ValueError: If epoch < 0 or max_batch_bytes <= 0
        """
        # Validate inputs
        if epoch < 0:
            raise ValueError("epoch must be >= 0")
        if max_batch_bytes <= 0:
            raise ValueError("maxBatchBytes must be > 0")
        if max_in_flight <= 0:
            raise ValueError("max_in_flight must be > 0")
        if linger_ms < 0:
            raise ValueError("linger_ms must be >= 0")

        self._url = url
        self._producer_id = producer_id
        self._epoch = epoch
        self._next_seq = 0
        self._auto_claim = auto_claim
        self._max_batch_bytes = max_batch_bytes
        self._linger_ms = linger_ms
        self._max_in_flight = max_in_flight
        self._content_type = content_type
        self._on_error = on_error
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=30.0)

        # Batching state
        self._pending_batch: list[_PendingEntry] = []
        self._batch_bytes = 0
        self._linger_task: asyncio.Task[None] | None = None

        # Pipelining state
        self._in_flight: dict[int, asyncio.Task[None]] = {}  # seq -> task
        self._closed = False

        # When auto_claim is true, epoch is not yet known until first batch completes
        # We block pipelining until then to avoid racing with the claim
        self._epoch_claimed = not auto_claim

        # Track sequence completions for 409 retry coordination
        # When HTTP requests arrive out of order, we get 409 errors.
        # Maps epoch -> (seq -> _SeqState)
        self._seq_state: dict[int, dict[int, _SeqState]] = {}

    @property
    def epoch(self) -> int:
        """Current epoch for this producer."""
        return self._epoch

    @property
    def next_seq(self) -> int:
        """Next sequence number to be assigned."""
        return self._next_seq

    @property
    def pending_count(self) -> int:
        """Number of messages in the current pending batch."""
        return len(self._pending_batch)

    @property
    def in_flight_count(self) -> int:
        """Number of batches currently in flight."""
        return len(self._in_flight)

    def append(self, body: bytes | str | Any) -> None:
        """
        Append data to the stream.

        This is fire-and-forget: returns immediately after adding to the batch.
        The message is batched and sent when:
        - max_batch_bytes is reached
        - linger_ms elapses
        - flush() is called

        Errors are reported via on_error callback if configured. Use flush() to
        wait for all pending messages to be sent.

        Args:
            body: Data to append. For JSON streams, pass native objects (dict, list, etc.)
                  which will be serialized internally. For byte streams, pass bytes or str.

        Raises:
            DurableStreamError: If producer is closed
        """
        if self._closed:
            raise DurableStreamError(
                f"Producer is closed: {self._url}",
                code="ALREADY_CLOSED",
                status=None,
            )

        is_json = _normalize_content_type(self._content_type) == "application/json"

        if is_json:
            # For JSON mode: accept native objects, serialize internally
            data_bytes = json.dumps(body).encode("utf-8")
            parsed_data = body
        else:
            # For byte mode: require bytes or str
            if isinstance(body, str):
                data_bytes = body.encode("utf-8")
            elif isinstance(body, bytes):
                data_bytes = body
            else:
                raise DurableStreamError(
                    "Non-JSON streams require bytes or str",
                    code="BAD_REQUEST",
                    status=400,
                )
            parsed_data = data_bytes

        entry = _PendingEntry(body=data_bytes, data=parsed_data)
        self._pending_batch.append(entry)
        self._batch_bytes += len(data_bytes)

        # Check if batch should be sent immediately
        if self._batch_bytes >= self._max_batch_bytes:
            self._send_current_batch()
        elif self._linger_task is None:
            # Start linger timer
            self._linger_task = asyncio.create_task(self._linger_timeout())

    async def _linger_timeout(self) -> None:
        """Wait for linger_ms then send pending batch."""
        await asyncio.sleep(self._linger_ms / 1000.0)
        self._linger_task = None
        if self._pending_batch:
            self._send_current_batch()

    async def flush(self) -> None:
        """
        Send any pending batch immediately and wait for all in-flight batches.

        Call this before shutdown to ensure all messages are delivered.
        """
        # Cancel linger timeout
        if self._linger_task is not None:
            self._linger_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._linger_task
            self._linger_task = None

        # Loop until both pending and in-flight are drained
        while self._pending_batch or self._in_flight:
            # Try to send pending batch
            if self._pending_batch:
                self._send_current_batch()

            # If still have pending but at capacity, wait for one to complete
            if self._pending_batch and len(self._in_flight) >= self._max_in_flight:
                if self._in_flight:
                    done, _ = await asyncio.wait(
                        self._in_flight.values(), return_when=asyncio.FIRST_COMPLETED
                    )
                    # Clean up completed tasks
                    for task in done:
                        for seq, t in list(self._in_flight.items()):
                            if t is task:
                                del self._in_flight[seq]
                                break
                continue

            # Wait for all current in-flight to complete
            if self._in_flight:
                # Capture the tasks we're about to await - callbacks may add more during await
                tasks_to_wait = list(self._in_flight.items())
                results = await asyncio.gather(
                    *[t for _, t in tasks_to_wait], return_exceptions=True
                )
                # Only remove the specific tasks we awaited (callbacks may have added more)
                for seq, _ in tasks_to_wait:
                    self._in_flight.pop(seq, None)
                # Re-raise the first exception if any failed
                for result in results:
                    if isinstance(result, Exception):
                        raise result

    async def close(self) -> None:
        """
        Flush pending messages and close the producer.

        After calling close(), further append() calls will throw.
        """
        if self._closed:
            return

        self._closed = True

        with contextlib.suppress(Exception):
            await self.flush()

        if self._owns_client:
            await self._client.aclose()

    async def restart(self) -> None:
        """
        Increment epoch and reset sequence.

        Call this when restarting the producer to establish a new session.
        Flushes any pending messages first.
        """
        await self.flush()
        self._epoch += 1
        self._next_seq = 0

    def _signal_seq_complete(
        self, epoch: int, seq: int, error: Exception | None
    ) -> None:
        """Signal that a sequence has completed (success or failure)."""
        if epoch not in self._seq_state:
            self._seq_state[epoch] = {}

        epoch_map = self._seq_state[epoch]
        state = epoch_map.get(seq)

        if state:
            # Mark resolved and notify all waiters
            state.resolved = True
            state.error = error
            for waiter in state.waiters:
                if not waiter.done():
                    if error:
                        waiter.set_exception(error)
                    else:
                        waiter.set_result(None)
            state.waiters = []
        else:
            # No waiters yet, just mark as resolved
            epoch_map[seq] = _SeqState(resolved=True, error=error)

        # Clean up old entries to prevent unbounded memory growth.
        # We keep entries for the last max_in_flight * 3 sequences to handle
        # potential late 409 retries from pipelining.
        cleanup_threshold = seq - self._max_in_flight * 3
        if cleanup_threshold > 0:
            old_seqs = [s for s in epoch_map if s < cleanup_threshold]
            for old_seq in old_seqs:
                del epoch_map[old_seq]

    async def _wait_for_seq(self, epoch: int, seq: int) -> None:
        """Wait for a specific sequence to complete. Raises if the sequence failed."""
        if epoch not in self._seq_state:
            self._seq_state[epoch] = {}

        epoch_map = self._seq_state[epoch]
        state = epoch_map.get(seq)

        if state and state.resolved:
            # Already completed
            if state.error:
                raise state.error
            return

        # Not yet completed, add a waiter
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        if state:
            state.waiters.append(future)
        else:
            epoch_map[seq] = _SeqState(resolved=False, waiters=[future])

        await future

    def _send_current_batch(self) -> None:
        """Send the current batch and track it in flight."""
        if not self._pending_batch:
            return

        # Wait if we've hit the in-flight limit
        if len(self._in_flight) >= self._max_in_flight:
            return

        # When auto_claim is enabled and epoch hasn't been claimed yet,
        # we must wait for any in-flight batch to complete before sending more.
        # This ensures the first batch claims the epoch before pipelining begins.
        if self._auto_claim and not self._epoch_claimed and len(self._in_flight) > 0:
            return

        # Take the current batch
        batch = self._pending_batch
        seq = self._next_seq

        self._pending_batch = []
        self._batch_bytes = 0
        self._next_seq += 1

        # Track this batch in flight
        task = asyncio.create_task(self._send_batch(batch, seq))
        self._in_flight[seq] = task

        # Clean up when done and maybe send pending batch
        def on_done(_task: asyncio.Task[None]) -> None:
            self._in_flight.pop(seq, None)
            # Try to send pending batch if any
            if self._pending_batch and len(self._in_flight) < self._max_in_flight:
                self._send_current_batch()

        task.add_done_callback(on_done)

    async def _send_batch(self, batch: list[_PendingEntry], seq: int) -> None:
        """Send a batch to the server."""
        epoch = self._epoch
        try:
            await self._do_send_batch(batch, seq, epoch)

            # Mark epoch as claimed after first successful batch
            # This enables full pipelining for subsequent batches
            if not self._epoch_claimed:
                self._epoch_claimed = True

            # Signal success for this sequence (for 409 retry coordination)
            self._signal_seq_complete(epoch, seq, None)
        except Exception as e:
            # Signal failure so waiting batches can fail too
            self._signal_seq_complete(epoch, seq, e)
            # Call on_error callback if configured
            if self._on_error is not None:
                self._on_error(e)
            raise

    async def _do_send_batch(
        self, batch: list[_PendingEntry], seq: int, epoch: int
    ) -> IdempotentAppendResult:
        """
        Actually send the batch to the server.
        Handles auto-claim retry on 403 (stale epoch) if auto_claim is enabled.
        Does NOT implement general retry/backoff for network errors or 5xx responses.
        """
        is_json = _normalize_content_type(self._content_type) == "application/json"

        # Build batch body based on content type
        if is_json:
            # For JSON mode: always send as array (server flattens one level)
            # Single append: [value] → server stores value
            # Multiple appends: [val1, val2] → server stores val1, val2
            values = [entry.data for entry in batch]
            batched_body = json.dumps(values).encode("utf-8")
        else:
            # For byte mode: concatenate all chunks
            batched_body = b"".join(entry.body for entry in batch)

        # Build headers
        headers = {
            "content-type": self._content_type,
            PRODUCER_ID_HEADER: self._producer_id,
            PRODUCER_EPOCH_HEADER: str(epoch),
            PRODUCER_SEQ_HEADER: str(seq),
        }

        # Send request
        response = await self._client.post(
            self._url,
            content=batched_body,
            headers=headers,
        )

        # Handle response
        if response.status_code == 204:
            # Duplicate - idempotent success
            return IdempotentAppendResult(offset="", duplicate=True)

        if response.status_code == 200:
            # Success
            result_offset = response.headers.get(STREAM_NEXT_OFFSET_HEADER, "")
            return IdempotentAppendResult(offset=result_offset, duplicate=False)

        if response.status_code == 403:
            # Stale epoch
            current_epoch_str = response.headers.get(PRODUCER_EPOCH_HEADER)
            current_epoch = int(current_epoch_str) if current_epoch_str else epoch

            if self._auto_claim:
                # Auto-claim: retry with epoch+1
                new_epoch = current_epoch + 1
                self._epoch = new_epoch
                self._next_seq = 1  # This batch will use seq 0

                # Retry with new epoch, starting at seq 0
                return await self._do_send_batch(batch, 0, new_epoch)

            raise StaleEpochError(current_epoch)

        if response.status_code == 409:
            # Sequence gap - our request arrived before an earlier sequence
            expected_seq_str = response.headers.get(PRODUCER_EXPECTED_SEQ_HEADER)
            expected_seq = int(expected_seq_str) if expected_seq_str else 0

            # If our seq is ahead of expectedSeq, wait for earlier sequences then retry
            # This handles HTTP request reordering with max_in_flight > 1
            if expected_seq < seq:
                # Wait for all sequences from expected_seq to seq-1
                for s in range(expected_seq, seq):
                    await self._wait_for_seq(epoch, s)
                # Retry now that earlier sequences have completed
                return await self._do_send_batch(batch, seq, epoch)

            # If expectedSeq >= seq, something is wrong (shouldn't happen) - throw error
            received_seq_str = response.headers.get(PRODUCER_RECEIVED_SEQ_HEADER)
            received_seq = int(received_seq_str) if received_seq_str else seq
            raise SequenceGapError(expected_seq, received_seq)

        if response.status_code == 400:
            # Bad request (e.g., invalid epoch/seq)
            text = response.text
            raise DurableStreamError(
                f"{text or 'Bad request'}: {self._url}",
                code="BAD_REQUEST",
                status=400,
            )

        # Other errors
        raise FetchError(
            f"Unexpected status {response.status_code}",
            status=response.status_code,
            url=self._url,
        )

    async def __aenter__(self) -> IdempotentProducer:
        """Async context manager entry."""
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        """Async context manager exit."""
        await self.close()
