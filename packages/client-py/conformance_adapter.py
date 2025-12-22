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
    global server_url, stream_content_types
    server_url = cmd["serverUrl"]
    stream_content_types.clear()

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
    url = f"{server_url}{cmd['path']}"

    # Get content type from cache or default
    content_type = stream_content_types.get(cmd["path"], "application/octet-stream")

    headers = cmd.get("headers")
    ds = DurableStream(url, content_type=content_type, headers=headers, batching=False)

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

    ds.append(data, seq=seq)
    head = ds.head()
    ds.close()

    return {
        "type": "append",
        "success": True,
        "status": 200,
        "offset": head.offset,
    }


def handle_read(cmd: dict[str, Any]) -> dict[str, Any]:
    """Handle read command."""
    url = f"{server_url}{cmd['path']}"
    offset = cmd.get("offset")

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
            # For SSE mode, use iter_text() which properly handles SSE events
            try:
                chunk_count = 0
                for text_chunk in response.iter_text():
                    if text_chunk:
                        chunks.append(
                            {
                                "data": text_chunk,
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
                # Timeout is expected
                pass
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
