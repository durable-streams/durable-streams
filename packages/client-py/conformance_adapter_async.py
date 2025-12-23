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
}

# Global state
server_url = ""
stream_content_types: dict[str, str] = {}


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


async def handle_init(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle init command."""
    global server_url, stream_content_types
    server_url = cmd["serverUrl"]
    stream_content_types.clear()

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
            ds = AsyncDurableStream(url, content_type=content_type, headers=headers, batching=False)
            await ds.append(data, seq=seq)
            head = await ds.head()
            await ds.aclose()

            return {
                "type": "append",
                "success": True,
                "status": 200,
                "offset": head.offset,
            }
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

    headers = cmd.get("headers")
    timeout_seconds = timeout_ms / 1000.0

    chunks: list[dict[str, Any]] = []
    final_offset = offset
    up_to_date = False

    response = await astream(
        url,
        offset=offset,
        live=live,
        headers=headers,
        timeout=timeout_seconds,
    )
    async with response:
        final_offset = response.offset
        up_to_date = response.up_to_date

        if live is False:
            # For non-live mode, get all available data
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
            # Note: iter_events() buffers data events and yields them all after the control
            # event, so all yielded events will have up_to_date set to the same value.
            # We should consume all available events before checking wait_for_up_to_date.
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
                async for chunk in response:
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
