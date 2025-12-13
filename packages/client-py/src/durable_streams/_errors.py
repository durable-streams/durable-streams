"""
Exception hierarchy for the Durable Streams client.

This module defines all exceptions that can be raised by the library.
"""

from typing import Any


class DurableStreamError(Exception):
    """
    Base exception for all Durable Streams protocol errors.

    This is raised for protocol-level errors from the server.

    Attributes:
        message: Human-readable error message
        status: HTTP status code (if applicable)
        code: Error code for programmatic handling
        details: Additional error details
    """

    def __init__(
        self,
        message: str,
        status: int | None = None,
        code: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details

    def __str__(self) -> str:
        parts = [self.message]
        if self.status is not None:
            parts.append(f"(status={self.status})")
        if self.code is not None:
            parts.append(f"[{self.code}]")
        return " ".join(parts)

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, "
            f"status={self.status!r}, "
            f"code={self.code!r})"
        )


class FetchError(Exception):
    """
    Exception for network/transport/timeout errors.

    This is raised for HTTP errors that are not specific to the Durable Streams
    protocol, such as network failures, timeouts, or server errors.

    Attributes:
        message: Human-readable error message
        status: HTTP status code (may be None for network errors)
        url: The URL that was being fetched
        headers: Response headers (if available)
        body: Response body (if available)
    """

    def __init__(
        self,
        message: str,
        status: int | None = None,
        url: str | None = None,
        headers: dict[str, str] | None = None,
        body: str | bytes | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.url = url
        self.headers = headers or {}
        self.body = body

    def __str__(self) -> str:
        parts = [self.message]
        if self.status is not None:
            parts.append(f"(status={self.status})")
        if self.url:
            parts.append(f"at {self.url}")
        return " ".join(parts)

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, "
            f"status={self.status!r}, "
            f"url={self.url!r})"
        )


class SeqConflictError(DurableStreamError):
    """
    Exception raised when a sequence conflict occurs during append.

    This happens when the `seq` header value is less than or equal to the
    last appended sequence, indicating an out-of-order write attempt.

    Corresponds to HTTP 409 Conflict with sequence regression.
    """

    def __init__(
        self,
        message: str = "Sequence conflict: seq is lower than or equal to last appended",
        details: Any = None,
    ) -> None:
        super().__init__(message, status=409, code="CONFLICT_SEQ", details=details)


class RetentionGoneError(DurableStreamError):
    """
    Exception raised when reading from an offset that has been pruned.

    This happens when the requested offset is before the earliest retained
    position due to retention/compaction policies.

    Corresponds to HTTP 410 Gone.
    """

    def __init__(
        self,
        message: str = "Offset is before the earliest retained position",
        details: Any = None,
    ) -> None:
        super().__init__(message, status=410, code="RETENTION_GONE", details=details)


class StreamConsumedError(DurableStreamError):
    """
    Exception raised when attempting to consume a stream response multiple times.

    StreamResponse is a one-shot object - it can only be consumed in one mode.
    Attempting to consume it again (or in a different mode) raises this error.
    """

    def __init__(
        self,
        message: str = "Stream has already been consumed",
        attempted_method: str | None = None,
        consumed_by: str | None = None,
    ) -> None:
        if attempted_method and consumed_by:
            message = (
                f"Cannot call {attempted_method}() - stream was already consumed "
                f"via {consumed_by}()"
            )
        super().__init__(message, code="ALREADY_CONSUMED")
        self.attempted_method = attempted_method
        self.consumed_by = consumed_by


class StreamNotFoundError(DurableStreamError):
    """
    Exception raised when the stream does not exist.

    Corresponds to HTTP 404 Not Found.
    """

    def __init__(
        self,
        message: str = "Stream not found",
        url: str | None = None,
    ) -> None:
        if url:
            message = f"Stream not found: {url}"
        super().__init__(message, status=404, code="NOT_FOUND")
        self.url = url


class StreamExistsError(DurableStreamError):
    """
    Exception raised when trying to create a stream that already exists
    with a different configuration.

    Corresponds to HTTP 409 Conflict for create operations.
    """

    def __init__(
        self,
        message: str = "Stream already exists with different configuration",
        url: str | None = None,
    ) -> None:
        if url:
            message = f"Stream already exists: {url}"
        super().__init__(message, status=409, code="CONFLICT_EXISTS")
        self.url = url


class SSENotSupportedError(DurableStreamError):
    """
    Exception raised when SSE mode is requested for a content type that
    doesn't support it.

    SSE is only valid for text/* or application/json content types.
    """

    def __init__(
        self,
        message: str = "SSE mode is not supported for this content type",
        content_type: str | None = None,
    ) -> None:
        if content_type:
            message = f"SSE mode is not supported for content type: {content_type}"
        super().__init__(message, status=400, code="SSE_NOT_SUPPORTED")
        self.content_type = content_type


class SSEBytesIterationError(DurableStreamError):
    """
    Exception raised when attempting to iterate bytes in SSE mode.

    In SSE mode, raw bytes iteration is not supported. Use iter_text()
    or iter_json() instead.
    """

    def __init__(self) -> None:
        super().__init__(
            "Cannot iterate bytes in SSE mode. Use iter_text() or iter_json() instead.",
            code="SSE_BYTES_NOT_SUPPORTED",
        )


class SSEReadAllError(DurableStreamError):
    """
    Exception raised when attempting to use read-all methods in SSE mode.

    In SSE mode, the connection stays open for live streaming, so read-all
    methods (read_text, read_json, read_json_batches) would hang indefinitely.
    Use iteration methods instead, or use live=False for catch-up reads.
    """

    def __init__(self, method: str) -> None:
        super().__init__(
            f"Cannot use {method}() in SSE mode - SSE connections stay open for "
            "live streaming. Use iteration methods (iter_json, iter_text) instead, "
            "or use live=False or live='long-poll' for read-all semantics.",
            code="SSE_READ_ALL_NOT_SUPPORTED",
        )
        self.method = method


def error_from_status(
    status: int,
    url: str,
    body: str | bytes | None = None,
    headers: dict[str, str] | None = None,  # noqa: ARG001 - kept for API compatibility
    operation: str | None = None,
) -> DurableStreamError:
    """
    Create an appropriate error from an HTTP status code.

    Args:
        status: The HTTP status code
        url: The URL that was requested
        body: The response body (if available)
        headers: The response headers (if available)
        operation: The operation being performed (e.g., "create", "append")

    Returns:
        An appropriate exception instance
    """
    details = body

    if status == 400:
        return DurableStreamError(
            f"Bad request: {url}",
            status=400,
            code="BAD_REQUEST",
            details=details,
        )

    if status == 401:
        return DurableStreamError(
            f"Unauthorized: {url}",
            status=401,
            code="UNAUTHORIZED",
            details=details,
        )

    if status == 403:
        return DurableStreamError(
            f"Forbidden: {url}",
            status=403,
            code="FORBIDDEN",
            details=details,
        )

    if status == 404:
        return StreamNotFoundError(url=url)

    if status == 409:
        if operation == "create":
            return StreamExistsError(url=url)
        return SeqConflictError(details=details)

    if status == 410:
        return RetentionGoneError(details=details)

    if status == 429:
        return DurableStreamError(
            f"Rate limited: {url}",
            status=429,
            code="RATE_LIMITED",
            details=details,
        )

    if status == 503:
        return DurableStreamError(
            f"Service unavailable: {url}",
            status=503,
            code="BUSY",
            details=details,
        )

    # Generic error for other HTTP status codes
    # Use DurableStreamError for protocol/server errors, reserve FetchError for
    # transport-level errors (network failures, timeouts, DNS, etc.)
    return DurableStreamError(
        f"HTTP error {status} at {url}",
        status=status,
        code="HTTP_ERROR",
        details=body,
    )
