"""
Integration tests that run against the JS reference server.

These tests require the server to be running. The test fixtures handle
starting and stopping the server automatically.
"""

from __future__ import annotations

import uuid

import pytest

from durable_streams import (
    DurableStream,
    astream,
    stream,
)
from durable_streams._errors import StreamNotFoundError

# Mark all tests in this file as integration tests
pytestmark = pytest.mark.integration


class TestIntegrationStreamBasics:
    """Basic integration tests for stream reading."""

    def test_create_and_read_stream(self, test_server):
        """Should create a stream and read from it."""
        stream_id = f"test-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        # Create the stream
        handle = DurableStream.create(
            url,
            content_type="text/plain",
        )

        try:
            # Append some data
            handle.append("hello world", seq="1")

            # Read it back
            with handle.stream(live=False) as res:
                text = res.read_text()
                assert text == "hello world"
        finally:
            handle.delete()
            handle.close()

    def test_read_json_stream(self, test_server):
        """Should create and read a JSON stream."""
        stream_id = f"test-json-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="application/json",
        )

        try:
            # Append JSON items
            handle.append({"id": 1, "name": "Alice"})
            handle.append({"id": 2, "name": "Bob"})

            # Read them back
            with handle.stream(live=False) as res:
                items = res.read_json()
                assert len(items) == 2
                assert items[0]["id"] == 1
                assert items[1]["id"] == 2
        finally:
            handle.delete()
            handle.close()

    def test_stream_offset_tracking(self, test_server):
        """Should track offsets correctly."""
        stream_id = f"test-offset-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="text/plain",
        )

        try:
            handle.append("first")
            handle.append("second")
            handle.append("third")

            with handle.stream(live=False) as res:
                # Read all data
                text = res.read_text()
                assert "first" in text
                assert "second" in text
                assert "third" in text

                # Offset should have advanced
                assert res.offset != "-1"
                assert res.up_to_date is True
        finally:
            handle.delete()
            handle.close()


class TestIntegrationTopLevelFunctions:
    """Integration tests for top-level stream functions."""

    def test_stream_function_with_existing_stream(self, test_server):
        """Should read from existing stream using stream()."""
        stream_id = f"test-fn-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        # Create and populate via DurableStream
        handle = DurableStream.create(url, content_type="text/plain")
        handle.append("test data")
        handle.close()

        try:
            # Read via top-level function
            with stream(url, live=False) as res:
                text = res.read_text()
                assert text == "test data"
        finally:
            DurableStream.delete_static(url)

    def test_stream_function_throws_on_missing(self, test_server):
        """Should throw StreamNotFoundError on missing stream."""
        url = f"{test_server.url}/non-existent-{uuid.uuid4().hex}"

        with pytest.raises(StreamNotFoundError) as exc_info:
            stream(url, live=False)

        assert exc_info.value.status == 404


class TestIntegrationDurableStreamMethods:
    """Integration tests for DurableStream methods."""

    def test_head_returns_metadata(self, test_server):
        """Should return stream metadata via head()."""
        stream_id = f"test-head-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="application/json")

        try:
            result = handle.head()

            assert result.exists is True
            assert "application/json" in (result.content_type or "")
            assert result.offset is not None
        finally:
            handle.delete()
            handle.close()

    def test_connect_validates_stream(self, test_server):
        """Should validate stream existence via connect()."""
        stream_id = f"test-connect-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        # Create the stream first
        create_handle = DurableStream.create(url, content_type="text/plain")
        create_handle.close()

        try:
            # Now connect to it
            handle = DurableStream.connect(url)
            assert handle.content_type is not None
            handle.close()
        finally:
            DurableStream.delete_static(url)

    def test_connect_throws_on_missing(self, test_server):
        """Should throw on connect() to missing stream."""
        url = f"{test_server.url}/non-existent-{uuid.uuid4().hex}"

        with pytest.raises(StreamNotFoundError):
            DurableStream.connect(url)


class TestIntegrationAppend:
    """Integration tests for appending data."""

    def test_append_returns_offset(self, test_server):
        """Should return new offset after append."""
        stream_id = f"test-append-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="text/plain",
            batching=False,  # Disable batching to get immediate result
        )

        try:
            result = handle.append("test data")
            assert result is not None
            assert result.next_offset != ""
        finally:
            handle.delete()
            handle.close()

    def test_append_multiple_times(self, test_server):
        """Should append multiple times correctly."""
        stream_id = f"test-multi-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="text/plain",
            batching=False,
        )

        try:
            handle.append("one")
            handle.append("two")
            handle.append("three")

            with handle.stream(live=False) as res:
                text = res.read_text()
                assert "one" in text
                assert "two" in text
                assert "three" in text
        finally:
            handle.delete()
            handle.close()


class TestIntegrationDelete:
    """Integration tests for stream deletion."""

    def test_delete_removes_stream(self, test_server):
        """Should delete stream."""
        stream_id = f"test-delete-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="text/plain")
        handle.delete()

        # Should not exist anymore
        with pytest.raises(StreamNotFoundError):
            DurableStream.connect(url)

        handle.close()

    def test_delete_static_removes_stream(self, test_server):
        """Should delete stream via static method."""
        stream_id = f"test-delete-static-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="text/plain")
        handle.close()

        DurableStream.delete_static(url)

        # Should not exist anymore
        with pytest.raises(StreamNotFoundError):
            DurableStream.connect(url)


class TestIntegrationIteration:
    """Integration tests for iteration methods."""

    def test_iter_text(self, test_server):
        """Should iterate text chunks."""
        stream_id = f"test-iter-text-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="text/plain")

        try:
            handle.append("hello ")
            handle.append("world")

            with handle.stream(live=False) as res:
                chunks = list(res.iter_text())
                combined = "".join(chunks)
                assert "hello" in combined
                assert "world" in combined
        finally:
            handle.delete()
            handle.close()

    def test_iter_json(self, test_server):
        """Should iterate JSON items."""
        stream_id = f"test-iter-json-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="application/json")

        try:
            handle.append({"id": 1})
            handle.append({"id": 2})
            handle.append({"id": 3})

            with handle.stream(live=False) as res:
                items = list(res.iter_json())
                assert len(items) == 3
                ids = [item["id"] for item in items]
                assert ids == [1, 2, 3]
        finally:
            handle.delete()
            handle.close()

    def test_iter_events(self, test_server):
        """Should iterate events with metadata."""
        stream_id = f"test-iter-events-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="application/json")

        try:
            handle.append([{"id": 1}, {"id": 2}])

            with handle.stream(live=False) as res:
                events = list(res.iter_events())
                assert len(events) >= 1
                assert events[-1].up_to_date is True
                assert events[-1].next_offset != ""
        finally:
            handle.delete()
            handle.close()


class TestIntegrationHeaders:
    """Integration tests for custom headers."""

    def test_custom_headers_are_sent(self, test_server):
        """Should send custom headers."""
        stream_id = f"test-headers-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        # Create with custom header
        handle = DurableStream.create(
            url,
            content_type="text/plain",
            headers={"X-Custom-Header": "test-value"},
        )

        try:
            # The server doesn't validate headers, but we can verify no errors
            handle.append("data")
            assert True  # If we got here, headers were accepted
        finally:
            handle.delete()
            handle.close()


class TestIntegrationParams:
    """Integration tests for query parameters."""

    def test_custom_params_are_sent(self, test_server):
        """Should send custom query parameters."""
        stream_id = f"test-params-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="text/plain",
            params={"custom": "param"},
        )

        try:
            # The server accepts params, verify no errors
            handle.append("data")
            with handle.stream(live=False, params={"another": "param"}) as res:
                _ = res.read_text()
            assert True
        finally:
            handle.delete()
            handle.close()


class TestIntegrationContextManager:
    """Integration tests for context manager protocol."""

    def test_context_manager_closes_properly(self, test_server):
        """Should close properly when using context manager."""
        stream_id = f"test-ctx-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="text/plain")
        handle.append("test")
        handle.close()

        try:
            with stream(url, live=False) as res:
                text = res.read_text()
                assert text == "test"

            assert res.closed is True
        finally:
            DurableStream.delete_static(url)


class TestIntegrationAsyncStream:
    """Integration tests for async stream functions."""

    @pytest.mark.anyio
    async def test_astream_reads_data(self, test_server):
        """Should read data via astream()."""
        stream_id = f"test-async-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        # Create and populate (sync)
        handle = DurableStream.create(url, content_type="text/plain")
        handle.append("async data")
        handle.close()

        try:
            res = await astream(url, live=False)
            async with res:
                text = await res.read_text()
                assert text == "async data"
        finally:
            DurableStream.delete_static(url)

    @pytest.mark.anyio
    async def test_astream_iter_json(self, test_server):
        """Should iterate JSON via astream()."""
        stream_id = f"test-async-json-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="application/json")
        handle.append({"id": 1})
        handle.append({"id": 2})
        handle.close()

        try:
            res = await astream(url, live=False)
            async with res:
                items = []
                async for item in res.iter_json():
                    items.append(item)

                assert len(items) == 2
                assert items[0]["id"] == 1
                assert items[1]["id"] == 2
        finally:
            DurableStream.delete_static(url)


class TestIntegrationBinaryData:
    """Integration tests for binary data."""

    def test_append_and_read_binary(self, test_server):
        """Should handle binary data correctly."""
        stream_id = f"test-binary-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="application/octet-stream",
        )

        try:
            binary_data = bytes(range(256))
            handle.append(binary_data)

            with handle.stream(live=False) as res:
                data = res.read_bytes()
                assert data == binary_data
        finally:
            handle.delete()
            handle.close()


class TestIntegrationOneShot:
    """Integration tests for one-shot consumption semantics."""

    def test_cannot_consume_twice(self, test_server):
        """Should throw when consuming twice."""
        stream_id = f"test-oneshot-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(url, content_type="text/plain")
        handle.append("data")

        try:
            with handle.stream(live=False) as res:
                _ = res.read_text()

                from durable_streams import StreamConsumedError

                with pytest.raises(StreamConsumedError):
                    res.read_text()
        finally:
            handle.delete()
            handle.close()


class TestIntegrationStreamTTL:
    """Integration tests for stream TTL."""

    def test_create_with_ttl(self, test_server):
        """Should create stream with TTL."""
        stream_id = f"test-ttl-{uuid.uuid4().hex[:8]}"
        url = f"{test_server.url}/{stream_id}"

        handle = DurableStream.create(
            url,
            content_type="text/plain",
            ttl_seconds=3600,  # 1 hour
        )

        try:
            result = handle.head()
            assert result.exists is True
        finally:
            handle.delete()
            handle.close()
