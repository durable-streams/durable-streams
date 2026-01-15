"""
Server-Sent Events (SSE) parsing for the Durable Streams protocol.

This module handles parsing of SSE event streams according to the protocol:
- `event: data` events contain the stream data
- `event: control` events contain `streamNextOffset` and optional `streamCursor`
"""

import codecs
import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

from durable_streams._errors import DurableStreamError
from durable_streams._types import Offset


@dataclass
class SSEDataEvent:
    """An SSE data event containing stream data."""

    type: str = "data"
    data: str = ""


@dataclass
class SSEControlEvent:
    """
    An SSE control event with stream metadata.

    Attributes:
        stream_next_offset: The next offset to read from
        stream_cursor: Optional cursor for CDN collapsing
        up_to_date: Whether caught up to end of stream
    """

    type: str = "control"
    stream_next_offset: Offset = ""
    stream_cursor: str | None = None
    up_to_date: bool = False


SSEEvent = SSEDataEvent | SSEControlEvent


class SSEParser:
    """
    Incremental SSE parser.

    Maintains state for parsing SSE events from a byte stream.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._current_event_type: str | None = None
        self._current_data: list[str] = []

    def feed(self, chunk: str) -> list[SSEEvent]:
        """
        Feed a chunk of data and return any complete events.

        Args:
            chunk: String chunk to parse

        Returns:
            List of complete SSE events
        """
        self._buffer += chunk
        events: list[SSEEvent] = []

        # Process complete lines
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)

            # Empty line signals end of event
            if line == "" or line == "\r":
                event = self._emit_event()
                if event is not None:
                    events.append(event)
                continue

            # Strip trailing CR if present
            if line.endswith("\r"):
                line = line[:-1]

            # Parse the line
            if line.startswith("event:"):
                self._current_event_type = line[6:].strip()
            elif line.startswith("data:"):
                # Per SSE spec, strip the optional space after "data:"
                content = line[5:]
                if content.startswith(" "):
                    content = content[1:]
                self._current_data.append(content)
            # Ignore other fields (id, retry, comments starting with :)

        return events

    def _emit_event(self) -> SSEEvent | None:
        """Emit the current event if valid."""
        if self._current_event_type is None or not self._current_data:
            self._reset()
            return None

        data_str = "\n".join(self._current_data)
        event_type = self._current_event_type
        self._reset()

        if event_type == "data":
            return SSEDataEvent(data=data_str)

        if event_type == "control":
            try:
                control = json.loads(data_str)
                return SSEControlEvent(
                    stream_next_offset=control.get("streamNextOffset", ""),
                    stream_cursor=control.get("streamCursor"),
                    up_to_date=control.get("upToDate", False),
                )
            except json.JSONDecodeError as e:
                # Control events contain critical offset data - don't silently ignore
                preview = data_str[:100] + "..." if len(data_str) > 100 else data_str
                raise DurableStreamError(
                    f"Failed to parse SSE control event: {e}. Data: {preview}",
                    code="PARSE_ERROR",
                ) from e

        return None

    def _reset(self) -> None:
        """Reset parser state for next event."""
        self._current_event_type = None
        self._current_data = []

    def finish(self) -> list[SSEEvent]:
        """
        Finish parsing and return any remaining events.

        Call this when the stream ends to handle any buffered data.

        Returns:
            List of any remaining complete events
        """
        events: list[SSEEvent] = []

        # Process remaining buffer - add double newline to flush event
        if self._buffer:
            remaining_events = self.feed("\n\n")
            events.extend(remaining_events)
            self._buffer = ""
        elif self._current_event_type is not None and self._current_data:
            # We have a partial event waiting - emit it
            event = self._emit_event()
            if event is not None:
                events.append(event)

        return events


def parse_sse_sync(byte_iterator: Iterator[bytes]) -> Iterator[SSEEvent]:
    """
    Parse SSE events from a synchronous byte iterator.

    Uses incremental UTF-8 decoding to handle multi-byte characters
    that may be split across chunk boundaries.

    Args:
        byte_iterator: Iterator yielding bytes

    Yields:
        Parsed SSE events
    """
    parser = SSEParser()
    # Use incremental decoder to handle UTF-8 codepoints split across chunks
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    for chunk in byte_iterator:
        text = decoder.decode(chunk)
        if text:
            for event in parser.feed(text):
                yield event

    # Flush any remaining bytes in the decoder
    final_text = decoder.decode(b"", final=True)
    if final_text:
        for event in parser.feed(final_text):
            yield event

    # Handle any remaining events in the parser
    for event in parser.finish():
        yield event


async def parse_sse_async(
    byte_iterator: AsyncIterator[bytes],
) -> AsyncIterator[SSEEvent]:
    """
    Parse SSE events from an asynchronous byte iterator.

    Uses incremental UTF-8 decoding to handle multi-byte characters
    that may be split across chunk boundaries.

    Args:
        byte_iterator: Async iterator yielding bytes

    Yields:
        Parsed SSE events
    """
    parser = SSEParser()
    # Use incremental decoder to handle UTF-8 codepoints split across chunks
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    async for chunk in byte_iterator:
        text = decoder.decode(chunk)
        if text:
            for event in parser.feed(text):
                yield event

    # Flush any remaining bytes in the decoder
    final_text = decoder.decode(b"", final=True)
    if final_text:
        for event in parser.feed(final_text):
            yield event

    # Handle any remaining events in the parser
    for event in parser.finish():
        yield event
