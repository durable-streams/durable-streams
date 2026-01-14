#!/usr/bin/env python3
"""
Async Python client adapter for Durable Streams conformance testing.

This adapter implements the stdin/stdout JSON-line protocol for the
durable-streams Python client package using the async API.

Run directly:
    python conformance_adapter_async.py

Or via uv:
    uv run conformance_adapter_async.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any

import httpx

from durable_streams import (
    AsyncDurableStream,
    DurableStreamError,
    FetchError,
    IdempotentProducer,
    SeqConflictError,
    StreamExistsError,
    StreamNotFoundError,
    __version__,
    astream,
)

# Error code constants matching the TypeScript protocol
ERROR_CODES = {
    "NETWORK_ERROR": "NETWORK_ERROR",
    "TIMEOUT": "TIMEOUT",
    "CONFLICT": "CONFLICT",
    "NOT_FOUND": "NOT_FOUND",
    "SEQUENCE_CONFLICT": "SEQUENCE_CONFLICT",
    "INVALID_OFFSET": "INVALID_OFFSET",
    "UNEXPECTED_STATUS": "UNEXPECTED_STATUS",
    "PARSE_ERROR": "PARSE_ERROR",
    "INTERNAL_ERROR": "INTERNAL_ERROR",
    "NOT_SUPPORTED": "NOT_SUPPORTED",
    "INVALID_ARGUMENT": "INVALID_ARGUMENT",
}

# Global state
server_url = ""
stream_content_types: dict[str, str] = {}

# Dynamic headers/params state
class DynamicValue:
    """Represents a dynamic value that can be evaluated per-request."""
    def __init__(self, value_type: str, initial_value: str | None = None):
        self.type = value_type  # "counter", "timestamp", or "token"
        self.counter = 0
        self.token_value = initial_value

    def get_value(self) -> str:
        """Get the current value, incrementing counter if applicable."""
        if self.type == "counter":
            self.counter += 1
            return str(self.counter)
        elif self.type == "timestamp":
            import time
            return str(int(time.time() * 1000))
        elif self.type == "token":
            return self.token_value or ""
        return ""


dynamic_headers: dict[str, DynamicValue] = {}
dynamic_params: dict[str, DynamicValue] = {}


def resolve_dynamic_headers() -> tuple[dict[str, str], dict[str, str]]:
    """Resolve dynamic headers, returning both header values and tracked values."""
    headers: dict[str, str] = {}
    values: dict[str, str] = {}

    for name, config in dynamic_headers.items():
        value = config.get_value()
        values[name] = value
        headers[name] = value

    return headers, values


def resolve_dynamic_params() -> tuple[dict[str, str], dict[str, str]]:
    """Resolve dynamic params, returning both param values and tracked values."""
    params: dict[str, str] = {}
    values: dict[str, str] = {}

    for name, config in dynamic_params.items():
        value = config.get_value()
        values[name] = value
        params[name] = value

    return params, values


def decode_base64(data: str) -> bytes:
    """Decode base64 string to bytes."""
    return base64.b64decode(data)


def encode_base64(data: bytes) -> str:
    """Encode bytes to base64 string."""
    return base64.b64encode(data).decode("ascii")


def map_error_code(err: Exception) -> tuple[str, int | None]:
    """Map a Python exception to an error code and optional status."""
    if isinstance(err, StreamNotFoundError):
        return ERROR_CODES["NOT_FOUND"], 404
    if isinstance(err, StreamExistsError):
        return ERROR_CODES["CONFLICT"], 409
    if isinstance(err, SeqConflictError):
        return ERROR_CODES["SEQUENCE_CONFLICT"], 409
    if isinstance(err, DurableStreamError):
        status = err.status
        code = err.code
        if code == "PARSE_ERROR":
            return ERROR_CODES["PARSE_ERROR"], None
        if code == "BAD_REQUEST":
            return ERROR_CODES["INVALID_OFFSET"], 400
        if status == 404:
            return ERROR_CODES["NOT_FOUND"], 404
        if status == 409:
            return ERROR_CODES["CONFLICT"], 409
        return ERROR_CODES["UNEXPECTED_STATUS"], status
    if isinstance(err, FetchError):
        status = err.status
        if status == 404:
            return ERROR_CODES["NOT_FOUND"], 404
        if status == 409:
            return ERROR_CODES["CONFLICT"], 409
        return ERROR_CODES["UNEXPECTED_STATUS"], status
    if isinstance(err, httpx.TimeoutException):
        return ERROR_CODES["TIMEOUT"], None
    if isinstance(err, httpx.ConnectError):
        return ERROR_CODES["NETWORK_ERROR"], None
    # JSON/UTF-8 parsing errors
    if isinstance(err, (json.JSONDecodeError, UnicodeDecodeError)):
        return ERROR_CODES["PARSE_ERROR"], None
    return ERROR_CODES["INTERNAL_ERROR"], None


def error_result(command_type: str, err: Exception) -> dict[str, Any]:
    """Create an error result from an exception."""
    error_code, status = map_error_code(err)
    result: dict[str, Any] = {
        "type": "error",
        "success": False,
        "commandType": command_type,
        "errorCode": error_code,
        "message": str(err),
    }
    if status is not None:
        result["status"] = status
    return result


async def handle_init(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle init command."""
    global server_url, stream_content_types
    server_url = cmd["serverUrl"]
    stream_content_types.clear()
    dynamic_headers.clear()
    dynamic_params.clear()

    return {
        "type": "init",
        "success": True,
        "clientName": "durable-streams-python-async",
        "clientVersion": __version__,
        "features": {
            "batching": True,
            "sse": True,
            "longPoll": True,
            "streaming": True,
            "dynamicHeaders": True,
            "strictZeroValidation": True,
        },
    }


async def handle_create(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle create command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"
    content_type = cmd.get("contentType", "application/octet-stream")

    # Check if stream already exists
    already_exists = False
    try:
        await AsyncDurableStream.head_static(url)
        already_exists = True
    except StreamNotFoundError:
        pass

    # Create the stream
    headers = cmd.get("headers")
    ds = await AsyncDurableStream.create(
        url,
        content_type=content_type,
        ttl_seconds=cmd.get("ttlSeconds"),
        expires_at=cmd.get("expiresAt"),
        headers=headers,
    )

    # Cache content type
    stream_content_types[cmd["path"]] = content_type

    # Get the current offset
    head = await ds.head()
    await ds.aclose()

    return {
        "type": "create",
        "success": True,
        "status": 200 if already_exists else 201,
        "offset": head.offset,
    }


async def handle_connect(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle connect command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    ds = await AsyncDurableStream.connect(url, headers=headers)

    head = await ds.head()

    # Cache content type
    if head.content_type:
        stream_content_types[cmd["path"]] = head.content_type

    await ds.aclose()

    return {
        "type": "connect",
        "success": True,
        "status": 200,
        "offset": head.offset,
    }


async def handle_append(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle append command."""
    url = f"{server_url}{cmd['path']}"

    # Get content type from cache or default
    content_type = stream_content_types.get(cmd["path"], "application/octet-stream")

    # Resolve dynamic headers/params
    dynamic_hdrs, headers_sent = resolve_dynamic_headers()
    _, params_sent = resolve_dynamic_params()

    # Merge command headers with dynamic headers (command takes precedence)
    cmd_headers: dict[str, str] = cmd.get("headers") or {}
    merged_headers: dict[str, str] = {**dynamic_hdrs, **cmd_headers}

    # Decode data
    data: bytes | str
    if cmd.get("binary"):
        data = decode_base64(cmd["data"])
    else:
        data = cmd["data"]

    # Get seq if provided
    seq = None
    if cmd.get("seq") is not None:
        seq = str(cmd["seq"])

    # Retry loop for 5xx errors (matching TypeScript client behavior)
    max_retries = 3
    base_delay = 0.1  # 100ms

    for attempt in range(max_retries + 1):
        try:
            ds = AsyncDurableStream(url, content_type=content_type, headers=merged_headers, batching=False)
            await ds.append(data, seq=seq)
            head = await ds.head()
            await ds.aclose()

            result: dict[str, Any] = {
                "type": "append",
                "success": True,
                "status": 200,
                "offset": head.offset,
            }
            if headers_sent:
                result["headersSent"] = headers_sent
            if params_sent:
                result["paramsSent"] = params_sent
            return result
        except (FetchError, DurableStreamError) as e:
            # Check if it's a retryable 5xx error
            status = getattr(e, "status", None)
            if status is not None and 500 <= status < 600 and attempt < max_retries:
                # Exponential backoff with jitter
                delay = base_delay * (2**attempt)
                await asyncio.sleep(delay)
                continue
            # Not retryable or max retries reached
            raise

    # This should never be reached - the loop always returns or raises
    raise RuntimeError("Unreachable: append retry loop completed without result")


async def handle_read(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle read command."""
    url = f"{server_url}{cmd['path']}"
    # Default to -1 (read from beginning) if no offset provided, matching TypeScript client behavior
    offset = cmd.get("offset") if cmd.get("offset") is not None else "-1"

    # Determine live mode
    live: bool | str
    cmd_live = cmd.get("live")
    is_sse = False
    if cmd_live == "long-poll":
        live = "long-poll"
    elif cmd_live == "sse":
        live = "sse"
        is_sse = True
    elif cmd_live is False:
        live = False
    else:
        live = False  # Default to catch-up only

    timeout_ms = cmd.get("timeoutMs", 5000)
    max_chunks = cmd.get("maxChunks", 100)
    wait_for_up_to_date = cmd.get("waitForUpToDate", False)

    # Resolve dynamic headers/params
    dynamic_hdrs, headers_sent = resolve_dynamic_headers()
    _, params_sent = resolve_dynamic_params()

    # Merge command headers with dynamic headers (command takes precedence)
    cmd_headers: dict[str, str] = cmd.get("headers") or {}
    merged_headers: dict[str, str] = {**dynamic_hdrs, **cmd_headers}
    timeout_seconds = timeout_ms / 1000.0

    chunks: list[dict[str, Any]] = []
    final_offset = offset
    up_to_date = False
    status = 200  # Default status

    response = await astream(
        url,
        offset=offset,
        live=live,
        headers=merged_headers,
        timeout=timeout_seconds,
    )
    async with response:
        status = response.status
        final_offset = response.offset
        up_to_date = response.up_to_date

        # Check if JSON content type
        content_type = stream_content_types.get(cmd["path"])
        is_json_content = content_type and "application/json" in content_type

        if live is False:
            # For non-live mode, get all available data
            if is_json_content:
                # Use JSON parsing to trigger PARSE_ERROR on malformed JSON
                import json as json_module
                items = await response.read_json()
                if items:
                    # Serialize items array as compact JSON (no spaces)
                    chunks.append(
                        {
                            "data": json_module.dumps(items, separators=(",", ":")),
                            "offset": response.offset,
                        }
                    )
                final_offset = response.offset
                up_to_date = response.up_to_date
            else:
                try:
                    data = await response.read_bytes()
                    if data:
                        chunks.append(
                            {
                                "data": data.decode("utf-8", errors="replace"),
                                "offset": response.offset,
                            }
                        )
                    final_offset = response.offset
                    up_to_date = response.up_to_date
                except Exception:
                    # Stream might be empty
                    pass
        elif is_sse:
            # For SSE mode, use iter_events() which yields StreamEvent objects for each
            # SSE data event, with metadata updated after control events.
            # The iterator yields empty events (data=None) for control-only batches,
            # allowing us to check upToDate even when no data was received.
            try:
                chunk_count = 0
                async for event in response.iter_events(mode="text"):
                    if event.data:
                        chunks.append(
                            {
                                "data": event.data,
                                "offset": event.next_offset,
                            }
                        )
                        chunk_count += 1

                    final_offset = event.next_offset
                    up_to_date = event.up_to_date

                    if chunk_count >= max_chunks:
                        break

                    # For waitForUpToDate: stop when upToDate becomes True AND
                    # we got an empty event (no data). This handles offset=now case.
                    # Don't break on data events - the iterator will stop after
                    # yielding all data when upToDate=True.
                    if wait_for_up_to_date and up_to_date and event.data is None:
                        break
            except httpx.TimeoutException:
                # Timeout is expected
                pass

            # Capture final state from response
            status = response.status
            final_offset = response.offset
            up_to_date = response.up_to_date
        else:
            # For long-poll mode, read the response body directly instead of using
            # iteration (which continues forever in live modes). Read initial response,
            # check upToDate, and only continue if not up-to-date and more data is needed.
            if response.status != 204:
                try:
                    # Read the initial response body
                    data = await response._response.aread()
                    if data:
                        chunks.append(
                            {
                                "data": data.decode("utf-8", errors="replace"),
                                "offset": response.offset,
                            }
                        )

                    final_offset = response.offset
                    up_to_date = response.up_to_date

                    # Continue polling until we reach maxChunks or timeout
                    chunk_count = 1 if data else 0
                    while chunk_count < max_chunks and not (wait_for_up_to_date and up_to_date):
                        # Do a long-poll fetch for more data
                        next_response = await response._fetch_next(response.offset, response.cursor)
                        response._update_metadata_from_response(next_response)

                        if next_response.status_code == 204:
                            # Long-poll timeout, no new data
                            await next_response.aclose()
                            up_to_date = response.up_to_date
                            final_offset = response.offset
                            break

                        data = await next_response.aread()
                        await next_response.aclose()

                        if data:
                            chunks.append(
                                {
                                    "data": data.decode("utf-8", errors="replace"),
                                    "offset": response.offset,
                                }
                            )
                            chunk_count += 1

                        final_offset = response.offset
                        up_to_date = response.up_to_date

                except httpx.TimeoutException:
                    # Timeout is expected for long-poll
                    pass

            # Capture final state from response
            status = response.status
            final_offset = response.offset
            up_to_date = response.up_to_date

    result: dict[str, Any] = {
        "type": "read",
        "success": True,
        "status": status,
        "chunks": chunks,
        "offset": final_offset,
        "upToDate": up_to_date,
    }
    if headers_sent:
        result["headersSent"] = headers_sent
    if params_sent:
        result["paramsSent"] = params_sent
    return result


async def handle_head(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle head command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    result = await AsyncDurableStream.head_static(url, headers=headers)

    # Cache content type
    if result.content_type:
        stream_content_types[cmd["path"]] = result.content_type

    return {
        "type": "head",
        "success": True,
        "status": 200,
        "offset": result.offset,
        "contentType": result.content_type,
    }


async def handle_delete(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle delete command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    await AsyncDurableStream.delete_static(url, headers=headers)

    # Remove from cache
    stream_content_types.pop(cmd["path"], None)

    return {
        "type": "delete",
        "success": True,
        "status": 200,
    }


async def handle_shutdown(_cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle shutdown command."""
    return {
        "type": "shutdown",
        "success": True,
    }


async def handle_benchmark(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle benchmark command with high-resolution timing."""
    import time
    import random

    iteration_id = cmd["iterationId"]
    operation = cmd["operation"]
    op_type = operation["op"]

    metrics: dict[str, Any] = {}

    start_ns = time.perf_counter_ns()

    if op_type == "append":
        url = f"{server_url}{operation['path']}"
        content_type = stream_content_types.get(operation["path"], "application/octet-stream")

        # Generate random payload
        size = operation["size"]
        payload = bytes(random.getrandbits(8) for _ in range(size))

        ds = AsyncDurableStream(url, content_type=content_type, batching=False)
        await ds.append(payload)
        await ds.aclose()
        metrics["bytesTransferred"] = size

    elif op_type == "read":
        url = f"{server_url}{operation['path']}"
        offset = operation.get("offset")

        async with await astream(url, offset=offset, live=False) as response:
            data = await response.read_bytes()
            metrics["bytesTransferred"] = len(data)

    elif op_type == "roundtrip":
        url = f"{server_url}{operation['path']}"
        size = operation["size"]
        content_type = operation.get("contentType", "application/octet-stream")
        live_mode = operation.get("live", "long-poll")

        # Create stream first
        ds = await AsyncDurableStream.create(url, content_type=content_type)
        stream_content_types[operation["path"]] = content_type

        # Generate random payload
        payload = bytes(random.getrandbits(8) for _ in range(size))

        # Start reading task before appending
        async def read_task():
            async with await astream(url, offset="-1", live=live_mode) as response:
                async for chunk in response:
                    if chunk:
                        return chunk
            return b""

        read_future = asyncio.create_task(read_task())

        # Append the data
        await ds.append(payload)
        await ds.aclose()

        # Wait for read to complete
        read_data = await read_future
        metrics["bytesTransferred"] = size + len(read_data)

    elif op_type == "create":
        url = f"{server_url}{operation['path']}"
        content_type = operation.get("contentType", "application/octet-stream")

        ds = await AsyncDurableStream.create(url, content_type=content_type)
        stream_content_types[operation["path"]] = content_type
        await ds.aclose()

    elif op_type == "throughput_append":
        url = f"{server_url}{operation['path']}"
        content_type = stream_content_types.get(operation["path"], "application/octet-stream")
        count = operation["count"]
        size = operation["size"]

        # Ensure stream exists
        try:
            await AsyncDurableStream.create(url, content_type=content_type)
        except StreamExistsError:
            pass

        # Generate payload
        payload = bytes(random.getrandbits(8) for _ in range(size))

        # Use IdempotentProducer for automatic batching and pipelining
        producer = IdempotentProducer(
            url,
            "bench-producer",
            content_type=content_type,
            linger_ms=0,  # No linger - send batches immediately
        )

        # Fire-and-forget: append returns immediately
        # Producer batches in background, errors via on_error callback
        for _ in range(count):
            producer.append(payload)
        await producer.flush()
        await producer.close()

        metrics["bytesTransferred"] = count * size
        metrics["messagesProcessed"] = count

    elif op_type == "throughput_read":
        url = f"{server_url}{operation['path']}"

        # Iterate over JSON messages and count them
        count = 0
        total_bytes = 0
        async with await astream(url, live=False) as response:
            async for item in response.iter_json():
                count += 1
                total_bytes += len(json.dumps(item))

        metrics["bytesTransferred"] = total_bytes
        metrics["messagesProcessed"] = count

    else:
        return {
            "type": "error",
            "success": False,
            "commandType": "benchmark",
            "errorCode": ERROR_CODES["NOT_SUPPORTED"],
            "message": f"Unknown benchmark operation: {op_type}",
        }

    end_ns = time.perf_counter_ns()
    duration_ns = end_ns - start_ns

    return {
        "type": "benchmark",
        "success": True,
        "iterationId": iteration_id,
        "durationNs": str(duration_ns),
        "metrics": metrics if metrics else None,
    }


def handle_set_dynamic_header(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle set-dynamic-header command."""
    name = cmd["name"]
    value_type = cmd["valueType"]
    initial_value = cmd.get("initialValue")
    dynamic_headers[name] = DynamicValue(value_type, initial_value)
    return {
        "type": "set-dynamic-header",
        "success": True,
    }


def handle_set_dynamic_param(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle set-dynamic-param command."""
    name = cmd["name"]
    value_type = cmd["valueType"]
    dynamic_params[name] = DynamicValue(value_type)
    return {
        "type": "set-dynamic-param",
        "success": True,
    }


def handle_clear_dynamic(_cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle clear-dynamic command."""
    dynamic_headers.clear()
    dynamic_params.clear()
    return {
        "type": "clear-dynamic",
        "success": True,
    }


def _normalize_content_type(content_type: str | None) -> str:
    """Normalize content-type by extracting media type (before semicolon)."""
    if not content_type:
        return ""
    return content_type.split(";")[0].strip().lower()


async def handle_idempotent_append(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle idempotent-append command."""
    url = f"{server_url}{cmd['path']}"

    # Get content-type from cache or use default
    content_type = stream_content_types.get(cmd["path"], "application/octet-stream")

    producer_id = cmd["producerId"]
    epoch = cmd.get("epoch", 0)
    auto_claim = cmd.get("autoClaim", False)
    data = cmd["data"]

    # For JSON streams, parse the string data into a native object
    # (IdempotentProducer now expects native objects for JSON streams)
    is_json = _normalize_content_type(content_type) == "application/json"
    if is_json and isinstance(data, str):
        data = json.loads(data)

    async with httpx.AsyncClient(timeout=30.0) as client:
        producer = IdempotentProducer(
            url=url,
            producer_id=producer_id,
            client=client,
            epoch=epoch,
            auto_claim=auto_claim,
            max_in_flight=1,  # Required when auto_claim is True
            linger_ms=0,  # Send immediately for testing
            content_type=content_type,
        )
        try:
            # append() is fire-and-forget (synchronous), then flush() sends the batch
            producer.append(data)
            await producer.flush()
            return {
                "type": "idempotent-append",
                "success": True,
                "status": 200,
            }
        finally:
            await producer.close()


async def handle_idempotent_append_batch(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle idempotent-append-batch command."""
    url = f"{server_url}{cmd['path']}"

    # Get content-type from cache or use default
    content_type = stream_content_types.get(cmd["path"], "application/octet-stream")

    producer_id = cmd["producerId"]
    epoch = cmd.get("epoch", 0)
    auto_claim = cmd.get("autoClaim", False)
    items = cmd["items"]

    # For JSON streams, parse the string items into native objects
    # (IdempotentProducer now expects native objects for JSON streams)
    is_json = _normalize_content_type(content_type) == "application/json"
    if is_json:
        items = [json.loads(item) if isinstance(item, str) else item for item in items]

    # Use provided maxInFlight or default to 1 for compatibility
    max_in_flight = cmd.get("maxInFlight", 1)

    # When testing concurrency (maxInFlight > 1), use small batches to force
    # multiple concurrent requests. Otherwise batch all items together.
    testing_concurrency = max_in_flight > 1

    async with httpx.AsyncClient(timeout=30.0) as client:
        producer = IdempotentProducer(
            url=url,
            producer_id=producer_id,
            client=client,
            epoch=epoch,
            auto_claim=auto_claim,
            max_in_flight=max_in_flight,
            linger_ms=0 if testing_concurrency else 1000,
            max_batch_bytes=1 if testing_concurrency else 1024 * 1024,
            content_type=content_type,
        )
        try:
            # append() is fire-and-forget (synchronous), adds to pending batch
            for item in items:
                producer.append(item)

            # flush() sends the batch and waits for completion
            await producer.flush()

            return {
                "type": "idempotent-append-batch",
                "success": True,
                "status": 200,
            }
        finally:
            await producer.close()


def handle_validate(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle validate command for testing client-side input validation."""
    target = cmd["target"]
    target_type = target["target"]

    try:
        if target_type == "retry-options":
            # Python client does not have a separate RetryOptions class
            return {
                "type": "error",
                "success": False,
                "commandType": "validate",
                "errorCode": ERROR_CODES["NOT_SUPPORTED"],
                "message": "Python client does not have RetryOptions class",
            }
        elif target_type == "idempotent-producer":
            # Test IdempotentProducer validation by attempting to create one
            producer_id = target.get("producerId", "test-producer")
            epoch = target.get("epoch", 0)
            max_batch_bytes = target.get("maxBatchBytes", 1024 * 1024)
            max_in_flight = target.get("maxInFlight", 5)
            linger_ms = target.get("lingerMs", 5)

            # Create a producer to test validation (use a dummy URL)
            _producer = IdempotentProducer(
                url="http://localhost:9999/test-validate",
                producer_id=producer_id,
                epoch=epoch,
                max_batch_bytes=max_batch_bytes,
                max_in_flight=max_in_flight,
                linger_ms=linger_ms,
            )

            return {
                "type": "validate",
                "success": True,
            }
        else:
            return {
                "type": "error",
                "success": False,
                "commandType": "validate",
                "errorCode": ERROR_CODES["NOT_SUPPORTED"],
                "message": f"Unknown validation target: {target_type}",
            }
    except ValueError as e:
        return {
            "type": "error",
            "success": False,
            "commandType": "validate",
            "errorCode": ERROR_CODES["INVALID_ARGUMENT"],
            "message": str(e),
        }


async def handle_command(cmd: dict[str, Any]) -> dict[str, Any]:
    """Route command to appropriate handler."""
    cmd_type = cmd["type"]

    try:
        if cmd_type == "init":
            return await handle_init(cmd)
        elif cmd_type == "create":
            return await handle_create(cmd)
        elif cmd_type == "connect":
            return await handle_connect(cmd)
        elif cmd_type == "append":
            return await handle_append(cmd)
        elif cmd_type == "read":
            return await handle_read(cmd)
        elif cmd_type == "head":
            return await handle_head(cmd)
        elif cmd_type == "delete":
            return await handle_delete(cmd)
        elif cmd_type == "shutdown":
            return await handle_shutdown(cmd)
        elif cmd_type == "benchmark":
            return await handle_benchmark(cmd)
        elif cmd_type == "set-dynamic-header":
            return handle_set_dynamic_header(cmd)
        elif cmd_type == "set-dynamic-param":
            return handle_set_dynamic_param(cmd)
        elif cmd_type == "clear-dynamic":
            return handle_clear_dynamic(cmd)
        elif cmd_type == "idempotent-append":
            return await handle_idempotent_append(cmd)
        elif cmd_type == "idempotent-append-batch":
            return await handle_idempotent_append_batch(cmd)
        elif cmd_type == "validate":
            return handle_validate(cmd)
        else:
            return {
                "type": "error",
                "success": False,
                "commandType": cmd_type,
                "errorCode": ERROR_CODES["NOT_SUPPORTED"],
                "message": f"Unknown command type: {cmd_type}",
            }
    except Exception as e:
        return error_result(cmd_type, e)


async def main() -> None:
    """Main entry point for the async adapter."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
            result = await handle_command(command)
            print(json.dumps(result), flush=True)

            if command["type"] == "shutdown":
                break
        except json.JSONDecodeError as e:
            print(
                json.dumps(
                    {
                        "type": "error",
                        "success": False,
                        "commandType": "init",
                        "errorCode": ERROR_CODES["PARSE_ERROR"],
                        "message": f"Failed to parse command: {e}",
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    asyncio.run(main())
