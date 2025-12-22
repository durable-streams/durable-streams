"""
Conformance tests for the Durable Streams protocol.

These tests verify that the Python client correctly implements the protocol
by testing against the reference JS server. They mirror the tests in
@durable-streams/conformance-tests.

These are integration tests that require the JS server to be running.
"""

from __future__ import annotations

import time
import uuid
from typing import TYPE_CHECKING

import httpx
import pytest

from durable_streams import (
    DurableStream,
    SeqConflictError,
    StreamExistsError,
    StreamNotFoundError,
)

if TYPE_CHECKING:
    from conftest import TestServer

# Mark all tests in this file as integration tests
pytestmark = pytest.mark.integration

# Protocol header names
STREAM_OFFSET_HEADER = "stream-next-offset"
STREAM_SEQ_HEADER = "stream-seq"
STREAM_UP_TO_DATE_HEADER = "stream-up-to-date"
STREAM_TTL_HEADER = "stream-ttl"
STREAM_EXPIRES_AT_HEADER = "stream-expires-at"


def unique_stream_path() -> str:
    """Generate a unique stream path for each test."""
    return f"/v1/stream/test-{uuid.uuid4().hex[:8]}-{int(time.time() * 1000)}"


# ============================================================================
# Basic Stream Operations
# ============================================================================


class TestBasicStreamOperations:
    """Basic stream CRUD operations."""

    def test_should_create_a_stream(self, test_server: TestServer) -> None:
        """Should create a stream."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain")
        try:
            assert stream.url == url
        finally:
            stream.delete()
            stream.close()

    def test_should_allow_idempotent_create_with_same_config(
        self, test_server: TestServer
    ) -> None:
        """Should allow idempotent create with same config."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        # Create first stream
        stream1 = DurableStream.create(url, content_type="text/plain")

        try:
            # Create again with same config - should succeed (idempotent)
            stream2 = DurableStream.create(url, content_type="text/plain")
            stream2.close()
        finally:
            stream1.delete()
            stream1.close()

    def test_should_reject_create_with_different_config_409(
        self, test_server: TestServer
    ) -> None:
        """Should reject create with different config (409)."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        # Create with text/plain
        stream = DurableStream.create(url, content_type="text/plain")

        try:
            # Try to create with different content type - should fail
            with pytest.raises(StreamExistsError):
                DurableStream.create(url, content_type="application/json")
        finally:
            stream.delete()
            stream.close()

    def test_should_delete_a_stream(self, test_server: TestServer) -> None:
        """Should delete a stream."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain")
        stream.delete()

        # Verify it's gone by trying to read
        with pytest.raises(StreamNotFoundError):
            DurableStream.connect(url)

        stream.close()

    def test_should_properly_isolate_recreated_stream_after_delete(
        self, test_server: TestServer
    ) -> None:
        """Should properly isolate recreated stream after delete."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream and append data
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"old data",
            )

            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b" more old data",
            )

            # Verify old data exists
            read_old = client.get(f"{base_url}{stream_path}")
            assert read_old.text == "old data more old data"

            # Delete the stream
            delete_response = client.delete(f"{base_url}{stream_path}")
            assert delete_response.status_code == 204

            # Immediately recreate at same URL with different data
            recreate_response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"new data",
            )
            assert recreate_response.status_code == 201

            # Read the new stream - should only see new data, not old
            read_new = client.get(f"{base_url}{stream_path}")
            assert read_new.text == "new data"
            assert "old data" not in read_new.text

            # Verify Stream-Up-To-Date is true
            assert read_new.headers.get(STREAM_UP_TO_DATE_HEADER) == "true"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Append Operations
# ============================================================================


class TestAppendOperations:
    """Append operations testing."""

    def test_should_append_string_data(self, test_server: TestServer) -> None:
        """Should append string data."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain", batching=False)

        try:
            stream.append("hello world")

            with stream.stream(live=False) as res:
                text = res.read_text()
                assert text == "hello world"
        finally:
            stream.delete()
            stream.close()

    def test_should_append_multiple_chunks(self, test_server: TestServer) -> None:
        """Should append multiple chunks."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain", batching=False)

        try:
            stream.append("chunk1")
            stream.append("chunk2")
            stream.append("chunk3")

            with stream.stream(live=False) as res:
                text = res.read_text()
                assert text == "chunk1chunk2chunk3"
        finally:
            stream.delete()
            stream.close()

    def test_should_enforce_sequence_ordering_with_seq(
        self, test_server: TestServer
    ) -> None:
        """Should enforce sequence ordering with seq."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain", batching=False)

        try:
            stream.append("first", seq="001")
            stream.append("second", seq="002")

            # Trying to append with lower seq should fail
            with pytest.raises(SeqConflictError):
                stream.append("invalid", seq="001")
        finally:
            stream.delete()
            stream.close()


# ============================================================================
# Read Operations
# ============================================================================


class TestReadOperations:
    """Read operations testing."""

    def test_should_read_empty_stream(self, test_server: TestServer) -> None:
        """Should read empty stream."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain")

        try:
            with stream.stream(live=False) as res:
                data = res.read_bytes()
                assert len(data) == 0
                assert res.up_to_date is True
        finally:
            stream.delete()
            stream.close()

    def test_should_read_stream_with_data(self, test_server: TestServer) -> None:
        """Should read stream with data."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain", batching=False)

        try:
            stream.append("hello")

            with stream.stream(live=False) as res:
                text = res.read_text()
                assert text == "hello"
                assert res.up_to_date is True
        finally:
            stream.delete()
            stream.close()

    def test_should_read_from_offset(self, test_server: TestServer) -> None:
        """Should read from offset."""
        stream_path = unique_stream_path()
        url = f"{test_server.url}{stream_path}"

        stream = DurableStream.create(url, content_type="text/plain", batching=False)

        try:
            stream.append("first")

            with stream.stream(live=False) as res:
                res.read_text()
                first_offset = res.offset

            stream.append("second")

            with stream.stream(offset=first_offset, live=False) as res:
                text = res.read_text()
                assert text == "second"
        finally:
            stream.delete()
            stream.close()


# ============================================================================
# HTTP Protocol Tests
# ============================================================================


class TestHttpProtocol:
    """HTTP protocol compliance tests."""

    def test_should_return_correct_headers_on_put(
        self, test_server: TestServer
    ) -> None:
        """Should return correct headers on PUT."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            assert response.status_code == 201
            assert response.headers.get("content-type") == "text/plain"
            assert response.headers.get(STREAM_OFFSET_HEADER) is not None

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_200_on_idempotent_put_with_same_config(
        self, test_server: TestServer
    ) -> None:
        """Should return 200 on idempotent PUT with same config."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # First PUT
            first_response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )
            assert first_response.status_code == 201

            # Second PUT with same config should succeed
            second_response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )
            assert second_response.status_code in [200, 204]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_409_on_put_with_different_config(
        self, test_server: TestServer
    ) -> None:
        """Should return 409 on PUT with different config."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # First PUT with text/plain
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Second PUT with different content type should fail
            response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
            )

            assert response.status_code == 409

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_correct_headers_on_post(
        self, test_server: TestServer
    ) -> None:
        """Should return correct headers on POST."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append data
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"hello world",
            )

            assert response.status_code in [200, 204]
            assert response.headers.get(STREAM_OFFSET_HEADER) is not None

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_404_on_post_to_non_existent_stream(
        self, test_server: TestServer
    ) -> None:
        """Should return 404 on POST to non-existent stream."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"data",
            )

            assert response.status_code == 404

    def test_should_return_400_or_409_on_content_type_mismatch(
        self, test_server: TestServer
    ) -> None:
        """Should return 400 or 409 on content-type mismatch."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with text/plain
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Try to append with application/json
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
                content=b"{}",
            )

            assert response.status_code in [400, 409]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_correct_headers_on_get(
        self, test_server: TestServer
    ) -> None:
        """Should return correct headers on GET."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create and add data
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test data",
            )

            # Read data
            response = client.get(f"{base_url}{stream_path}")

            assert response.status_code == 200
            assert response.headers.get("content-type") == "text/plain"
            assert response.headers.get(STREAM_OFFSET_HEADER) is not None
            assert response.headers.get(STREAM_UP_TO_DATE_HEADER) == "true"
            # Note: ETag is optional per protocol (SHOULD, not MUST)
            # assert response.headers.get("etag") is not None
            assert response.text == "test data"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_empty_body_with_up_to_date_for_empty_stream(
        self, test_server: TestServer
    ) -> None:
        """Should return empty body with up-to-date for empty stream."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create empty stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Read empty stream
            response = client.get(f"{base_url}{stream_path}")

            assert response.status_code == 200
            assert response.headers.get(STREAM_OFFSET_HEADER) is not None
            assert response.headers.get(STREAM_UP_TO_DATE_HEADER) == "true"
            assert response.text == ""

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_read_from_offset_http(self, test_server: TestServer) -> None:
        """Should read from offset via HTTP."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with data
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"first",
            )

            # Get the offset
            first_response = client.get(f"{base_url}{stream_path}")
            middle_offset = first_response.headers.get(STREAM_OFFSET_HEADER)

            # Append more
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"second",
            )

            # Read from the middle offset
            response = client.get(
                f"{base_url}{stream_path}",
                params={"offset": middle_offset},
            )

            assert response.status_code == 200
            assert response.text == "second"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_404_on_delete_non_existent_stream(
        self, test_server: TestServer
    ) -> None:
        """Should return 404 on DELETE non-existent stream."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.delete(f"{base_url}{stream_path}")
            assert response.status_code == 404

    def test_should_return_204_on_successful_delete(
        self, test_server: TestServer
    ) -> None:
        """Should return 204 on successful DELETE."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Delete it
            response = client.delete(f"{base_url}{stream_path}")
            assert response.status_code == 204

            # Verify it's gone
            read_response = client.get(f"{base_url}{stream_path}")
            assert read_response.status_code == 404

    def test_should_enforce_sequence_ordering_http(
        self, test_server: TestServer
    ) -> None:
        """Should enforce sequence ordering via HTTP."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append with seq 001
            client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "001",
                },
                content=b"first",
            )

            # Append with seq 002
            client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "002",
                },
                content=b"second",
            )

            # Try to append with seq 001 (regression) - should fail
            response = client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "001",
                },
                content=b"invalid",
            )

            assert response.status_code == 409

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_enforce_lexicographic_seq_ordering(
        self, test_server: TestServer
    ) -> None:
        """Should enforce lexicographic seq ordering ("2" then "10" rejects)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append with seq "2"
            client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "2",
                },
                content=b"first",
            )

            # Try to append with seq "10" - should fail
            # Lexicographically "10" < "2"
            response = client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "10",
                },
                content=b"second",
            )

            assert response.status_code == 409

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_allow_lexicographic_seq_ordering_padded(
        self, test_server: TestServer
    ) -> None:
        """Should allow lexicographic seq ordering ("09" then "10" succeeds)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append with seq "09"
            client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "09",
                },
                content=b"first",
            )

            # Append with seq "10" - should succeed
            # Lexicographically "10" > "09"
            response = client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "10",
                },
                content=b"second",
            )

            assert response.status_code in [200, 204]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_reject_duplicate_seq_values(self, test_server: TestServer) -> None:
        """Should reject duplicate seq values."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append with seq "001"
            client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "001",
                },
                content=b"first",
            )

            # Try to append with same seq "001" - should fail
            response = client.post(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_SEQ_HEADER: "001",
                },
                content=b"duplicate",
            )

            assert response.status_code == 409

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# TTL and Expiry Validation
# ============================================================================


class TestTtlAndExpiryValidation:
    """TTL and expiry validation tests."""

    def test_should_reject_both_ttl_and_expires_at_400(
        self, test_server: TestServer
    ) -> None:
        """Should reject both TTL and Expires-At (400)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        from datetime import datetime, timedelta, timezone

        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_TTL_HEADER: "3600",
                    STREAM_EXPIRES_AT_HEADER: expires_at,
                },
            )

            assert response.status_code == 400

    def test_should_reject_invalid_ttl_non_integer(
        self, test_server: TestServer
    ) -> None:
        """Should reject invalid TTL (non-integer)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_TTL_HEADER: "abc",
                },
            )

            assert response.status_code == 400

    def test_should_reject_negative_ttl(self, test_server: TestServer) -> None:
        """Should reject negative TTL."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_TTL_HEADER: "-1",
                },
            )

            assert response.status_code == 400

    def test_should_accept_valid_ttl(self, test_server: TestServer) -> None:
        """Should accept valid TTL."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_TTL_HEADER: "3600",
                },
            )

            assert response.status_code in [200, 201]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_accept_valid_expires_at(self, test_server: TestServer) -> None:
        """Should accept valid Expires-At."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        from datetime import datetime, timedelta, timezone

        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={
                    "Content-Type": "text/plain",
                    STREAM_EXPIRES_AT_HEADER: expires_at,
                },
            )

            assert response.status_code in [200, 201]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Case-Insensitivity Tests
# ============================================================================


class TestCaseInsensitivity:
    """Case-insensitivity tests."""

    def test_should_treat_content_type_case_insensitively(
        self, test_server: TestServer
    ) -> None:
        """Should treat content-type case-insensitively."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with lowercase content-type
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append with mixed case - should succeed
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "TEXT/PLAIN"},
                content=b"test",
            )

            assert response.status_code in [200, 204]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_allow_idempotent_create_with_different_case_content_type(
        self, test_server: TestServer
    ) -> None:
        """Should allow idempotent create with different case content-type."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with lowercase
            response1 = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
            )
            assert response1.status_code == 201

            # PUT again with uppercase - should be idempotent
            response2 = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "APPLICATION/JSON"},
            )
            assert response2.status_code in [200, 204]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Content-Type Validation
# ============================================================================


class TestContentTypeValidation:
    """Content-type validation tests."""

    def test_should_enforce_content_type_match_on_append(
        self, test_server: TestServer
    ) -> None:
        """Should enforce content-type match on append."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with text/plain
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Try to append with application/json - should fail
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
                content=b'{"test": true}',
            )

            assert response.status_code in [400, 409]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_allow_append_with_matching_content_type(
        self, test_server: TestServer
    ) -> None:
        """Should allow append with matching content-type."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with application/json
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
            )

            # Append with same content-type - should succeed
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
                content=b'[{"test": true}]',
            )

            assert response.status_code in [200, 204]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_stream_content_type_on_get(
        self, test_server: TestServer
    ) -> None:
        """Should return stream content-type on GET."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create with application/json
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/json"},
                content=b'[{"initial": true}]',
            )

            # Read and verify content-type
            response = client.get(f"{base_url}{stream_path}")

            assert response.status_code == 200
            assert response.headers.get("content-type") == "application/json"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# HEAD Metadata Tests
# ============================================================================


class TestHeadMetadata:
    """HEAD metadata tests."""

    def test_should_return_metadata_without_body(self, test_server: TestServer) -> None:
        """Should return metadata without body."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream with data
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test data",
            )

            # HEAD request
            response = client.head(f"{base_url}{stream_path}")

            assert response.status_code == 200
            assert response.headers.get("content-type") == "text/plain"
            assert response.headers.get(STREAM_OFFSET_HEADER) is not None

            # Body should be empty
            assert response.text == ""

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_404_for_non_existent_stream(
        self, test_server: TestServer
    ) -> None:
        """Should return 404 for non-existent stream."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.head(f"{base_url}{stream_path}")
            assert response.status_code == 404

    def test_should_return_tail_offset(self, test_server: TestServer) -> None:
        """Should return tail offset."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create empty stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # HEAD should show initial offset
            response1 = client.head(f"{base_url}{stream_path}")
            offset1 = response1.headers.get(STREAM_OFFSET_HEADER)
            assert offset1 is not None

            # Append data
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test",
            )

            # HEAD should show updated offset
            response2 = client.head(f"{base_url}{stream_path}")
            offset2 = response2.headers.get(STREAM_OFFSET_HEADER)
            assert offset2 is not None
            assert offset2 != offset1

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Offset Validation and Resumability
# ============================================================================


class TestOffsetValidationAndResumability:
    """Offset validation and resumability tests."""

    def test_should_reject_malformed_offset_contains_comma(
        self, test_server: TestServer
    ) -> None:
        """Should reject malformed offset (contains comma)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test",
            )

            response = client.get(
                f"{base_url}{stream_path}",
                params={"offset": "0,1"},
            )

            assert response.status_code == 400

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_reject_offset_with_spaces(self, test_server: TestServer) -> None:
        """Should reject offset with spaces."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test",
            )

            response = client.get(
                f"{base_url}{stream_path}",
                params={"offset": "0 1"},
            )

            assert response.status_code == 400

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_support_resumable_reads_no_duplicate_data(
        self, test_server: TestServer
    ) -> None:
        """Should support resumable reads (no duplicate data)."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append chunk 1
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"chunk1",
            )

            # Read chunk 1
            response1 = client.get(f"{base_url}{stream_path}")
            text1 = response1.text
            offset1 = response1.headers.get(STREAM_OFFSET_HEADER)

            assert text1 == "chunk1"
            assert offset1 is not None

            # Append chunk 2
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"chunk2",
            )

            # Read from offset1 - should only get chunk2
            response2 = client.get(
                f"{base_url}{stream_path}",
                params={"offset": offset1},
            )
            text2 = response2.text

            assert text2 == "chunk2"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_empty_response_when_reading_from_tail_offset(
        self, test_server: TestServer
    ) -> None:
        """Should return empty response when reading from tail offset."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream with data
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test",
            )

            # Read all data
            response1 = client.get(f"{base_url}{stream_path}")
            tail_offset = response1.headers.get(STREAM_OFFSET_HEADER)

            # Read from tail offset - should return empty with up-to-date
            response2 = client.get(
                f"{base_url}{stream_path}",
                params={"offset": tail_offset},
            )

            assert response2.status_code == 200
            assert response2.text == ""
            assert response2.headers.get(STREAM_UP_TO_DATE_HEADER) == "true"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Protocol Edge Cases
# ============================================================================


class TestProtocolEdgeCases:
    """Protocol edge case tests."""

    def test_should_reject_empty_post_body_with_400(
        self, test_server: TestServer
    ) -> None:
        """Should reject empty POST body with 400."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Try to append empty body - should fail
            response = client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"",
            )

            assert response.status_code == 400

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_handle_put_with_initial_body_correctly(
        self, test_server: TestServer
    ) -> None:
        """Should handle PUT with initial body correctly."""
        stream_path = unique_stream_path()
        base_url = test_server.url
        initial_data = b"initial stream content"

        with httpx.Client() as client:
            # Create stream with initial content
            put_response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=initial_data,
            )

            assert put_response.status_code == 201
            assert put_response.headers.get(STREAM_OFFSET_HEADER) is not None

            # Verify we can read the initial content
            get_response = client.get(f"{base_url}{stream_path}")

            assert get_response.text == initial_data.decode()
            assert get_response.headers.get(STREAM_UP_TO_DATE_HEADER) == "true"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_handle_binary_data_with_integrity(
        self, test_server: TestServer
    ) -> None:
        """Should handle binary data with integrity."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        # Binary data with various byte values including 0x00 and 0xFF
        binary_data = bytes([0x00, 0x01, 0x02, 0x7F, 0x80, 0xFE, 0xFF])

        with httpx.Client() as client:
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/octet-stream"},
                content=binary_data,
            )

            # Read back and verify byte-for-byte
            response = client.get(f"{base_url}{stream_path}")

            result = response.content
            assert len(result) == len(binary_data)
            for i in range(len(binary_data)):
                assert result[i] == binary_data[i]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_return_location_header_on_201(
        self, test_server: TestServer
    ) -> None:
        """Should return Location header on 201."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            response = client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            assert response.status_code == 201
            location = response.headers.get("location")
            assert location is not None
            assert location == f"{base_url}{stream_path}"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_handle_missing_content_type_on_post(
        self, test_server: TestServer
    ) -> None:
        """Should handle missing Content-Type on POST.

        Note: The protocol allows servers to accept or reject (400/409) POST
        requests without Content-Type. The reference server is permissive.
        """
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Try to append without Content-Type
            # Server may accept (200/204) or reject (400/409)
            response = client.post(
                f"{base_url}{stream_path}",
                content=b"data",
            )

            assert response.status_code in [200, 204, 400, 409]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_ignore_unknown_query_parameters(
        self, test_server: TestServer
    ) -> None:
        """Should ignore unknown query parameters."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"test data",
            )

            # Should work fine with unknown params
            response = client.get(
                f"{base_url}{stream_path}",
                params={"offset": "-1", "foo": "bar", "baz": "qux"},
            )

            assert response.status_code == 200
            assert response.text == "test data"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Read-Your-Writes Consistency
# ============================================================================


class TestReadYourWritesConsistency:
    """Read-your-writes consistency tests."""

    def test_should_immediately_read_message_after_append(
        self, test_server: TestServer
    ) -> None:
        """Should immediately read message after append."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream and append
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"initial",
            )

            # Immediately read - should see the data
            response = client.get(f"{base_url}{stream_path}")

            assert response.text == "initial"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")

    def test_should_immediately_read_multiple_appends(
        self, test_server: TestServer
    ) -> None:
        """Should immediately read multiple appends."""
        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
            )

            # Append multiple messages
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"msg1",
            )
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"msg2",
            )
            client.post(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "text/plain"},
                content=b"msg3",
            )

            # Immediately read - should see all messages
            response = client.get(f"{base_url}{stream_path}")

            assert response.text == "msg1msg2msg3"

            # Cleanup
            client.delete(f"{base_url}{stream_path}")


# ============================================================================
# Byte-Exactness Invariant
# ============================================================================


class TestByteExactnessInvariant:
    """Byte-exactness invariant tests."""

    def test_reading_from_offset_repeatedly_yields_exact_bytes_appended(
        self, test_server: TestServer
    ) -> None:
        """Reading from offset repeatedly yields exact bytes appended."""
        import random

        stream_path = unique_stream_path()
        base_url = test_server.url

        with httpx.Client() as client:
            # Create stream
            client.put(
                f"{base_url}{stream_path}",
                headers={"Content-Type": "application/octet-stream"},
            )

            # Append random-sized chunks of binary data
            chunks: list[bytes] = []
            chunk_sizes = [1, 2, 7, 100, 1024]

            for size in chunk_sizes:
                chunk = bytes([random.randint(0, 255) for _ in range(size)])
                chunks.append(chunk)

                client.post(
                    f"{base_url}{stream_path}",
                    headers={"Content-Type": "application/octet-stream"},
                    content=chunk,
                )

            # Calculate expected concatenated result
            expected = b"".join(chunks)

            # Read entire stream by following Stream-Next-Offset
            accumulated = b""
            current_offset: str | None = None
            iterations = 0
            max_iterations = 100

            while iterations < max_iterations:
                iterations += 1

                params = {"offset": current_offset} if current_offset else {}
                response = client.get(f"{base_url}{stream_path}", params=params)
                assert response.status_code == 200

                data = response.content
                if len(data) > 0:
                    accumulated += data

                next_offset = response.headers.get(STREAM_OFFSET_HEADER)
                up_to_date = response.headers.get(STREAM_UP_TO_DATE_HEADER)

                if up_to_date == "true" and len(data) == 0:
                    break

                assert next_offset is not None
                if next_offset == current_offset:
                    raise RuntimeError(
                        f"Offset did not progress: stuck at {current_offset}"
                    )

                current_offset = next_offset

            assert iterations < max_iterations

            # Verify byte-for-byte exactness
            assert len(accumulated) == len(expected)
            for i in range(len(expected)):
                assert accumulated[i] == expected[i]

            # Cleanup
            client.delete(f"{base_url}{stream_path}")
