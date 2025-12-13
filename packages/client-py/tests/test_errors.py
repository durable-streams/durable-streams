"""Tests for error handling."""

from durable_streams._errors import (
    DurableStreamError,
    FetchError,
    RetentionGoneError,
    SeqConflictError,
    SSEBytesIterationError,
    SSENotSupportedError,
    StreamConsumedError,
    StreamExistsError,
    StreamNotFoundError,
    error_from_status,
)


class TestDurableStreamError:
    """Tests for DurableStreamError."""

    def test_basic_error(self) -> None:
        error = DurableStreamError("Something went wrong")
        assert str(error) == "Something went wrong"
        assert error.status is None
        assert error.code is None

    def test_error_with_status_and_code(self) -> None:
        error = DurableStreamError("Not found", status=404, code="NOT_FOUND")
        assert "Not found" in str(error)
        assert "(status=404)" in str(error)
        assert "[NOT_FOUND]" in str(error)
        assert error.status == 404
        assert error.code == "NOT_FOUND"

    def test_error_with_details(self) -> None:
        error = DurableStreamError("Error", details={"extra": "info"})
        assert error.details == {"extra": "info"}


class TestFetchError:
    """Tests for FetchError."""

    def test_basic_fetch_error(self) -> None:
        error = FetchError("Network error")
        assert str(error) == "Network error"
        assert error.status is None

    def test_fetch_error_with_status(self) -> None:
        error = FetchError("Server error", status=500, url="https://example.com")
        assert "500" in str(error)
        assert "example.com" in str(error)

    def test_fetch_error_with_body(self) -> None:
        error = FetchError("Error", body="Response body")
        assert error.body == "Response body"


class TestSpecificErrors:
    """Tests for specific error types."""

    def test_seq_conflict_error(self) -> None:
        error = SeqConflictError()
        assert error.status == 409
        assert error.code == "CONFLICT_SEQ"
        assert "sequence" in str(error).lower()

    def test_retention_gone_error(self) -> None:
        error = RetentionGoneError()
        assert error.status == 410
        assert error.code == "RETENTION_GONE"

    def test_stream_consumed_error(self) -> None:
        error = StreamConsumedError(
            attempted_method="read_json",
            consumed_by="iter_bytes",
        )
        assert error.code == "ALREADY_CONSUMED"
        assert "read_json" in str(error)
        assert "iter_bytes" in str(error)

    def test_stream_not_found_error(self) -> None:
        error = StreamNotFoundError(url="https://example.com/stream")
        assert error.status == 404
        assert error.code == "NOT_FOUND"
        assert "example.com" in str(error)

    def test_stream_exists_error(self) -> None:
        error = StreamExistsError(url="https://example.com/stream")
        assert error.status == 409
        assert error.code == "CONFLICT_EXISTS"

    def test_sse_not_supported_error(self) -> None:
        error = SSENotSupportedError(content_type="application/octet-stream")
        assert error.status == 400
        assert error.code == "SSE_NOT_SUPPORTED"
        assert "octet-stream" in str(error)

    def test_sse_bytes_iteration_error(self) -> None:
        error = SSEBytesIterationError()
        assert "iter_text" in str(error) or "iter_json" in str(error)


class TestErrorFromStatus:
    """Tests for error_from_status factory function."""

    def test_400_bad_request(self) -> None:
        error = error_from_status(400, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 400
        assert error.code == "BAD_REQUEST"

    def test_401_unauthorized(self) -> None:
        error = error_from_status(401, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 401
        assert error.code == "UNAUTHORIZED"

    def test_403_forbidden(self) -> None:
        error = error_from_status(403, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 403
        assert error.code == "FORBIDDEN"

    def test_404_not_found(self) -> None:
        error = error_from_status(404, "https://example.com")
        assert isinstance(error, StreamNotFoundError)
        assert error.status == 404

    def test_409_conflict_default(self) -> None:
        error = error_from_status(409, "https://example.com")
        assert isinstance(error, SeqConflictError)

    def test_409_conflict_create(self) -> None:
        error = error_from_status(409, "https://example.com", operation="create")
        assert isinstance(error, StreamExistsError)

    def test_410_gone(self) -> None:
        error = error_from_status(410, "https://example.com")
        assert isinstance(error, RetentionGoneError)

    def test_429_rate_limited(self) -> None:
        error = error_from_status(429, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 429
        assert error.code == "RATE_LIMITED"

    def test_503_busy(self) -> None:
        error = error_from_status(503, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 503
        assert error.code == "BUSY"

    def test_unknown_status(self) -> None:
        """Unknown HTTP statuses return DurableStreamError (not FetchError).

        FetchError is reserved for transport-level errors like network failures.
        """
        error = error_from_status(418, "https://example.com")
        assert isinstance(error, DurableStreamError)
        assert error.status == 418
        assert error.code == "HTTP_ERROR"
