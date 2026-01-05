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
    Error thrown when a sequence gap is detected.
    This should never happen with proper client implementation.
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


@dataclass
class _PendingEntry:
    """Internal type for pending batch entries."""

    body: bytes
    future: asyncio.Future[IdempotentAppendResult] = field(
        default_factory=lambda: asyncio.get_event_loop().create_future()
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
        ...     # Fire-and-forget writes
        ...     await producer.append(b"message 1")
        ...     await producer.append(b"message 2")
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
        """
        self._url = url
        self._producer_id = producer_id
        self._epoch = epoch
        self._next_seq = 0
        self._auto_claim = auto_claim
        self._max_batch_bytes = max_batch_bytes
        self._linger_ms = linger_ms
        self._max_in_flight = max_in_flight
        self._content_type = content_type
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=30.0)

        # Batching state
        self._pending_batch: list[_PendingEntry] = []
        self._batch_bytes = 0
        self._linger_task: asyncio.Task[None] | None = None

        # Pipelining state
        self._in_flight: dict[int, asyncio.Task[None]] = {}  # seq -> task
        self._closed = False

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

    async def append(self, body: bytes | str) -> IdempotentAppendResult:
        """
        Append data to the stream.

        The message is added to the current batch and sent when:
        - max_batch_bytes is reached
        - linger_ms elapses
        - flush() is called

        Args:
            body: Data to append (bytes or str)

        Returns:
            Result with offset and duplicate flag

        Raises:
            DurableStreamError: If producer is closed
            StaleEpochError: If epoch is stale and auto_claim is False
            SequenceGapError: If sequence gap detected (should never happen)
        """
        if self._closed:
            raise DurableStreamError(
                "Producer is closed",
                code="ALREADY_CLOSED",
                status=None,
                url=self._url,
            )

        data = body.encode("utf-8") if isinstance(body, str) else body

        # Create future for this entry
        loop = asyncio.get_event_loop()
        entry = _PendingEntry(body=data, future=loop.create_future())
        self._pending_batch.append(entry)
        self._batch_bytes += len(data)

        # Check if batch should be sent immediately
        if self._batch_bytes >= self._max_batch_bytes:
            self._send_current_batch()
        elif self._linger_task is None:
            # Start linger timer
            self._linger_task = asyncio.create_task(self._linger_timeout())

        return await entry.future

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
                await asyncio.gather(*self._in_flight.values(), return_exceptions=True)
                self._in_flight.clear()

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

    def _send_current_batch(self) -> None:
        """Send the current batch and track it in flight."""
        if not self._pending_batch:
            return

        # Wait if we've hit the in-flight limit
        if len(self._in_flight) >= self._max_in_flight:
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
        try:
            result = await self._do_send_batch(batch, seq, self._epoch)

            # Resolve all entries in the batch
            for entry in batch:
                if not entry.future.done():
                    entry.future.set_result(result)
        except Exception as e:
            # Reject all entries in the batch
            for entry in batch:
                if not entry.future.done():
                    entry.future.set_exception(e)
            raise

    async def _do_send_batch(
        self, batch: list[_PendingEntry], seq: int, epoch: int
    ) -> IdempotentAppendResult:
        """
        Actually send the batch to the server.
        Handles auto-claim retry on 403 (stale epoch) if auto_claim is enabled.
        Does NOT implement general retry/backoff for network errors or 5xx responses.
        """
        # Concatenate all bodies
        concatenated = b"".join(entry.body for entry in batch)

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
            content=concatenated,
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
            # Sequence gap
            expected_seq_str = response.headers.get(PRODUCER_EXPECTED_SEQ_HEADER)
            received_seq_str = response.headers.get(PRODUCER_RECEIVED_SEQ_HEADER)
            expected_seq = int(expected_seq_str) if expected_seq_str else 0
            received_seq = int(received_seq_str) if received_seq_str else seq

            raise SequenceGapError(expected_seq, received_seq)

        if response.status_code == 400:
            # Bad request (e.g., invalid epoch/seq)
            text = response.text
            raise DurableStreamError(
                text or "Bad request",
                code="BAD_REQUEST",
                status=400,
                url=self._url,
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
