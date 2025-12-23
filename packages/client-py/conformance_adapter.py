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
    dynamic_headers.clear()
    dynamic_params.clear()

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
            "dynamicHeaders": True,
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
            ds = DurableStream(url, content_type=content_type, headers=merged_headers, batching=False)
            ds.append(data, seq=seq)
            head = ds.head()
            ds.close()

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

    with stream(
        url,
        offset=offset,
        live=live,
        headers=merged_headers,
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

    result: dict[str, Any] = {
        "type": "read",
        "success": True,
        "status": 200,
        "chunks": chunks,
        "offset": final_offset,
        "upToDate": up_to_date,
    }
    if headers_sent:
        result["headersSent"] = headers_sent
    if params_sent:
        result["paramsSent"] = params_sent
    return result


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
        elif cmd_type == "set-dynamic-header":
            return handle_set_dynamic_header(cmd)
        elif cmd_type == "set-dynamic-param":
            return handle_set_dynamic_param(cmd)
        elif cmd_type == "clear-dynamic":
            return handle_clear_dynamic(cmd)
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
