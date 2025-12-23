#!/usr/bin/env python3
"""
Python client adapter for Durable Streams conformance testing.

This adapter implements the stdin/stdout JSON-line protocol for the
durable-streams Python client package.

Run directly:
    python conformance_adapter.py

Or via uv:
    uv run conformance_adapter.py
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

import httpx

from durable_streams import (
    DurableStream,
    DurableStreamError,
    FetchError,
    SeqConflictError,
    StreamExistsError,
    StreamNotFoundError,
    __version__,
    stream,
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
}

# Global state
server_url = ""
stream_content_types: dict[str, str] = {}
# Shared HTTP client for connection reuse (significant perf improvement)
shared_client: httpx.Client | None = None


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


def handle_init(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle init command."""
    global server_url, stream_content_types, shared_client
    server_url = cmd["serverUrl"]
    stream_content_types.clear()

    # Close existing client if any, then create a new one for connection reuse
    if shared_client is not None:
        shared_client.close()
    shared_client = httpx.Client(timeout=30.0)

    return {
        "type": "init",
        "success": True,
        "clientName": "durable-streams-python",
        "clientVersion": __version__,
        "features": {
            "batching": True,
            "sse": True,
            "longPoll": True,
            "streaming": True,
        },
    }


def handle_create(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle create command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"
    content_type = cmd.get("contentType", "application/octet-stream")

    # Check if stream already exists
    already_exists = False
    try:
        DurableStream.head_static(url)
        already_exists = True
    except StreamNotFoundError:
        pass

    # Create the stream
    headers = cmd.get("headers")
    ds = DurableStream.create(
        url,
        content_type=content_type,
        ttl_seconds=cmd.get("ttlSeconds"),
        expires_at=cmd.get("expiresAt"),
        headers=headers,
    )

    # Cache content type
    stream_content_types[cmd["path"]] = content_type

    # Get the current offset
    head = ds.head()
    ds.close()

    return {
        "type": "create",
        "success": True,
        "status": 200 if already_exists else 201,
        "offset": head.offset,
    }


def handle_connect(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle connect command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    ds = DurableStream.connect(url, headers=headers)

    head = ds.head()

    # Cache content type
    if head.content_type:
        stream_content_types[cmd["path"]] = head.content_type

    ds.close()

    return {
        "type": "connect",
        "success": True,
        "status": 200,
        "offset": head.offset,
    }


def handle_append(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle append command."""
    import time

    url = f"{server_url}{cmd['path']}"

    # Get content type from cache or default
    content_type = stream_content_types.get(cmd["path"], "application/octet-stream")

    headers = cmd.get("headers")

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
            ds = DurableStream(url, content_type=content_type, headers=headers, batching=False)
            ds.append(data, seq=seq)
            head = ds.head()
            ds.close()

            return {
                "type": "append",
                "success": True,
                "status": 200,
                "offset": head.offset,
            }
        except (FetchError, DurableStreamError) as e:
            # Check if it's a retryable 5xx error
            status = getattr(e, 'status', None)
            if status is not None and 500 <= status < 600 and attempt < max_retries:
                # Exponential backoff with jitter
                delay = base_delay * (2 ** attempt)
                time.sleep(delay)
                continue
            # Not retryable or max retries reached
            raise


def handle_read(cmd: dict[str, Any]) -> dict[str, Any]:
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

    headers = cmd.get("headers")
    timeout_seconds = timeout_ms / 1000.0

    chunks: list[dict[str, Any]] = []
    final_offset = offset
    up_to_date = False

    with stream(
        url,
        offset=offset,
        live=live,
        headers=headers,
        timeout=timeout_seconds,
    ) as response:
        final_offset = response.offset
        up_to_date = response.up_to_date

        if live is False:
            # For non-live mode, get all available data
            try:
                data = response.read_bytes()
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
            # Note: iter_events() buffers data events and yields them all after the control
            # event, so all yielded events will have up_to_date set to the same value.
            # We should consume all available events before checking wait_for_up_to_date.
            try:
                chunk_count = 0
                for event in response.iter_events(mode="text"):
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

                    # Don't break on up_to_date inside the loop - SSE yields all buffered
                    # data at once after control event, so we need to consume them all
            except httpx.TimeoutException:
                # Timeout is expected
                pass

            # Capture final state from response
            final_offset = response.offset
            up_to_date = response.up_to_date

            # For waitForUpToDate, the test expects us to have reached up_to_date
            # This should naturally happen when we've consumed all buffered data
        else:
            # For long-poll mode, iterate raw bytes
            try:
                chunk_count = 0
                for chunk in response:
                    if chunk:
                        chunks.append(
                            {
                                "data": chunk.decode("utf-8", errors="replace"),
                                "offset": response.offset,
                            }
                        )
                        chunk_count += 1

                    final_offset = response.offset
                    up_to_date = response.up_to_date

                    if chunk_count >= max_chunks:
                        break

                    if wait_for_up_to_date and up_to_date:
                        break
            except httpx.TimeoutException:
                # Timeout is expected for long-poll
                pass

            # Capture final state from response
            final_offset = response.offset
            up_to_date = response.up_to_date

    return {
        "type": "read",
        "success": True,
        "status": 200,
        "chunks": chunks,
        "offset": final_offset,
        "upToDate": up_to_date,
    }


def handle_head(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle head command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    result = DurableStream.head_static(url, headers=headers)

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


def handle_delete(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle delete command."""
    global stream_content_types
    url = f"{server_url}{cmd['path']}"

    headers = cmd.get("headers")
    DurableStream.delete_static(url, headers=headers)

    # Remove from cache
    stream_content_types.pop(cmd["path"], None)

    return {
        "type": "delete",
        "success": True,
        "status": 200,
    }


def handle_shutdown(_cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle shutdown command."""
    return {
        "type": "shutdown",
        "success": True,
    }


def handle_benchmark(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle benchmark command with high-resolution timing."""
    import concurrent.futures
    import time

    iteration_id = cmd["iterationId"]
    operation = cmd["operation"]
    op_type = operation["op"]

    metrics: dict[str, Any] = {}

    try:
        start_time = time.perf_counter_ns()

        if op_type == "append":
            url = f"{server_url}{operation['path']}"
            content_type = stream_content_types.get(operation["path"], "application/octet-stream")
            # Use shared_client for connection reuse - major perf improvement
            ds = DurableStream(url, content_type=content_type, client=shared_client)

            # Generate payload efficiently (b'\x2a' * size is faster than bytes([42] * size))
            payload = b"\x2a" * operation["size"]

            ds.append(payload)
            # Don't close - we passed in a shared client
            metrics["bytesTransferred"] = operation["size"]

        elif op_type == "read":
            url = f"{server_url}{operation['path']}"
            offset = operation.get("offset")

            with stream(url, offset=offset, live=False, client=shared_client) as res:
                data = res.read_bytes()
                metrics["bytesTransferred"] = len(data) if data else 0

        elif op_type == "roundtrip":
            url = f"{server_url}{operation['path']}"
            content_type = operation.get("contentType", "application/octet-stream")
            live_mode = operation.get("live", "long-poll")

            # Use shared client for connection reuse - httpx.Client is thread-safe
            ds = DurableStream.create(url, content_type=content_type, client=shared_client)

            # Generate payload - use JSON for JSON content types, bytes otherwise
            if "json" in content_type.lower():
                # SSE requires JSON content type, so use a JSON payload
                payload: bytes | dict[str, str] = {"data": "x" * operation["size"]}
            else:
                payload = b"\x2a" * operation["size"]

            # Start reading before appending (to catch the data via live mode)
            # We need to use threading for this since stream() is blocking
            import threading

            read_data: bytes | None = None
            read_error: Exception | None = None

            def read_thread():
                nonlocal read_data, read_error
                try:
                    # Server requires offset param for live modes
                    # Start from "-1" (beginning of stream)
                    with ds.stream(live=live_mode, offset="-1") as res:
                        if live_mode == "sse":
                            # SSE mode requires text/json iteration, not bytes
                            for text in res.iter_text():
                                if text:
                                    read_data = text.encode("utf-8")
                                    break
                        else:
                            for chunk in res:
                                if chunk:
                                    read_data = chunk
                                    break
                except Exception as e:
                    read_error = e

            reader = threading.Thread(target=read_thread)
            reader.start()

            # Give the reader time to establish its connection
            # 5ms should be enough for the HTTP request to be in-flight
            time.sleep(0.005)

            # Append the data
            ds.append(payload)

            # Wait for read to complete (with timeout)
            reader.join(timeout=10.0)

            # Check if thread is still running (timed out)
            if reader.is_alive():
                # Thread is stuck - likely SSE connection issue
                # We can't easily kill it, but we can return an error
                raise TimeoutError("Reader thread timed out waiting for data")

            # Don't close - using shared client

            if read_error:
                raise read_error

            if read_data is None:
                raise RuntimeError("Reader finished but no data received")

            read_len = len(read_data)
            metrics["bytesTransferred"] = operation["size"] + read_len

        elif op_type == "create":
            url = f"{server_url}{operation['path']}"
            content_type = operation.get("contentType", "application/octet-stream")
            ds = DurableStream.create(url, content_type=content_type, client=shared_client)
            # Don't close - we passed in a shared client

        elif op_type == "throughput_append":
            import asyncio
            url = f"{server_url}{operation['path']}"
            content_type = stream_content_types.get(operation["path"], "application/octet-stream")

            # Ensure stream exists - use shared client
            try:
                DurableStream.create(url, content_type=content_type, client=shared_client)
            except StreamExistsError:
                pass

            # Generate payload efficiently
            payload = b"\x2a" * operation["size"]

            count = operation["count"]

            # Use asyncio for high-throughput - much more efficient than threads
            async def run_appends():
                from durable_streams import AsyncDurableStream
                async with httpx.AsyncClient(timeout=30.0) as async_client:
                    ds = AsyncDurableStream(url, content_type=content_type, client=async_client)
                    # Submit all appends concurrently - asyncio handles this efficiently
                    tasks = [ds.append(payload) for _ in range(count)]
                    await asyncio.gather(*tasks)

            asyncio.run(run_appends())

            metrics["bytesTransferred"] = count * operation["size"]
            metrics["messagesProcessed"] = count

        elif op_type == "throughput_read":
            url = f"{server_url}{operation['path']}"

            with stream(url, live=False, client=shared_client) as res:
                data = res.read_bytes()
                metrics["bytesTransferred"] = len(data) if data else 0

        else:
            return {
                "type": "error",
                "success": False,
                "commandType": "benchmark",
                "errorCode": ERROR_CODES["NOT_SUPPORTED"],
                "message": f"Unknown benchmark operation: {op_type}",
            }

        end_time = time.perf_counter_ns()
        duration_ns = end_time - start_time

        return {
            "type": "benchmark",
            "success": True,
            "iterationId": iteration_id,
            "durationNs": str(duration_ns),
            "metrics": metrics,
        }

    except Exception as e:
        import traceback
        print(f"[benchmark error] {op_type}: {e}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        return {
            "type": "error",
            "success": False,
            "commandType": "benchmark",
            "errorCode": ERROR_CODES["INTERNAL_ERROR"],
            "message": str(e),
        }


def handle_command(cmd: dict[str, Any]) -> dict[str, Any]:
    """Route command to appropriate handler."""
    cmd_type = cmd["type"]

    try:
        if cmd_type == "init":
            return handle_init(cmd)
        elif cmd_type == "create":
            return handle_create(cmd)
        elif cmd_type == "connect":
            return handle_connect(cmd)
        elif cmd_type == "append":
            return handle_append(cmd)
        elif cmd_type == "read":
            return handle_read(cmd)
        elif cmd_type == "head":
            return handle_head(cmd)
        elif cmd_type == "delete":
            return handle_delete(cmd)
        elif cmd_type == "shutdown":
            return handle_shutdown(cmd)
        elif cmd_type == "benchmark":
            return handle_benchmark(cmd)
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


def main() -> None:
    """Main entry point for the adapter."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
            result = handle_command(command)
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
    main()
