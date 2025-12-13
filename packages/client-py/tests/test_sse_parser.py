"""Tests for SSE parsing."""

from durable_streams._sse import (
    SSEControlEvent,
    SSEDataEvent,
    SSEParser,
    parse_sse_sync,
)


class TestSSEParser:
    """Tests for SSEParser."""

    def test_parses_data_event(self) -> None:
        parser = SSEParser()
        events = parser.feed("event: data\ndata: hello\n\n")
        assert len(events) == 1
        assert isinstance(events[0], SSEDataEvent)
        assert events[0].data == "hello"

    def test_parses_control_event(self) -> None:
        parser = SSEParser()
        events = parser.feed('event: control\ndata: {"streamNextOffset": "123"}\n\n')
        assert len(events) == 1
        assert isinstance(events[0], SSEControlEvent)
        assert events[0].stream_next_offset == "123"

    def test_parses_control_with_cursor(self) -> None:
        parser = SSEParser()
        events = parser.feed(
            'event: control\ndata: {"streamNextOffset": "123", "streamCursor": "abc"}\n\n'
        )
        assert len(events) == 1
        assert isinstance(events[0], SSEControlEvent)
        assert events[0].stream_next_offset == "123"
        assert events[0].stream_cursor == "abc"

    def test_parses_control_with_up_to_date(self) -> None:
        parser = SSEParser()
        events = parser.feed(
            'event: control\ndata: {"streamNextOffset": "123", "upToDate": true}\n\n'
        )
        assert len(events) == 1
        assert isinstance(events[0], SSEControlEvent)
        assert events[0].up_to_date is True

    def test_parses_multiline_data(self) -> None:
        parser = SSEParser()
        events = parser.feed("event: data\ndata: line1\ndata: line2\n\n")
        assert len(events) == 1
        assert isinstance(events[0], SSEDataEvent)
        assert events[0].data == "line1\nline2"

    def test_parses_multiple_events(self) -> None:
        parser = SSEParser()
        events = parser.feed(
            "event: data\ndata: first\n\nevent: data\ndata: second\n\n"
        )
        assert len(events) == 2
        assert events[0].data == "first"  # type: ignore[union-attr]
        assert events[1].data == "second"  # type: ignore[union-attr]

    def test_handles_partial_data(self) -> None:
        parser = SSEParser()

        # Feed partial data
        events1 = parser.feed("event: data\n")
        assert len(events1) == 0

        events2 = parser.feed("data: hello\n")
        assert len(events2) == 0

        events3 = parser.feed("\n")
        assert len(events3) == 1
        assert events3[0].data == "hello"  # type: ignore[union-attr]

    def test_strips_optional_space_after_data(self) -> None:
        parser = SSEParser()
        events = parser.feed("event: data\ndata: with space\n\n")
        assert events[0].data == "with space"  # type: ignore[union-attr]

    def test_ignores_comments(self) -> None:
        parser = SSEParser()
        events = parser.feed(": this is a comment\nevent: data\ndata: hello\n\n")
        assert len(events) == 1
        assert events[0].data == "hello"  # type: ignore[union-attr]

    def test_handles_carriage_return(self) -> None:
        parser = SSEParser()
        events = parser.feed("event: data\r\ndata: hello\r\n\r\n")
        assert len(events) == 1
        assert events[0].data == "hello"  # type: ignore[union-attr]

    def test_finish_flushes_remaining(self) -> None:
        parser = SSEParser()
        parser.feed("event: data\ndata: hello")
        events = parser.finish()
        assert len(events) == 1
        assert events[0].data == "hello"  # type: ignore[union-attr]


class TestParseSseSync:
    """Tests for parse_sse_sync."""

    def test_parses_byte_iterator(self) -> None:
        def byte_gen() -> list[bytes]:
            return [
                b"event: data\n",
                b"data: hello\n",
                b"\n",
            ]

        events = list(parse_sse_sync(iter(byte_gen())))
        assert len(events) == 1
        assert isinstance(events[0], SSEDataEvent)
        assert events[0].data == "hello"

    def test_parses_json_array_data(self) -> None:
        def byte_gen() -> list[bytes]:
            return [
                b"event: data\n",
                b'data: [{"id": 1}, {"id": 2}]\n',
                b"\n",
                b"event: control\n",
                b'data: {"streamNextOffset": "123"}\n',
                b"\n",
            ]

        events = list(parse_sse_sync(iter(byte_gen())))
        assert len(events) == 2
        assert events[0].data == '[{"id": 1}, {"id": 2}]'  # type: ignore[union-attr]
        assert events[1].stream_next_offset == "123"  # type: ignore[union-attr]

    def test_handles_multibyte_utf8_split_across_chunks(self) -> None:
        """
        Regression test: multibyte UTF-8 characters split across chunk boundaries.

        The Euro sign (€) is encoded as 3 bytes: 0xE2 0x82 0xAC
        The 🎉 emoji is encoded as 4 bytes: 0xF0 0x9F 0x8E 0x89

        If the decoder doesn't handle this correctly, it will produce
        UnicodeDecodeError or corrupted text.
        """
        # Euro sign split: first byte in one chunk, rest in another
        euro_bytes = "€".encode()  # b'\xe2\x82\xac'
        assert len(euro_bytes) == 3

        def byte_gen_euro() -> list[bytes]:
            return [
                b"event: data\n",
                b"data: price " + euro_bytes[:1],  # partial multibyte char
                euro_bytes[1:] + b"100\n",  # rest of char + more text
                b"\n",
            ]

        events = list(parse_sse_sync(iter(byte_gen_euro())))
        assert len(events) == 1
        assert events[0].data == "price €100"  # type: ignore[union-attr]

        # Emoji split: 2 bytes in one chunk, 2 in another
        emoji_bytes = "🎉".encode()  # b'\xf0\x9f\x8e\x89'
        assert len(emoji_bytes) == 4

        def byte_gen_emoji() -> list[bytes]:
            return [
                b"event: data\n",
                b"data: party " + emoji_bytes[:2],  # first 2 bytes
                emoji_bytes[2:] + b" time\n",  # last 2 bytes + more text
                b"\n",
            ]

        events = list(parse_sse_sync(iter(byte_gen_emoji())))
        assert len(events) == 1
        assert events[0].data == "party 🎉 time"  # type: ignore[union-attr]

    def test_handles_multiple_multibyte_chars_in_sequence(self) -> None:
        """Test multiple multibyte characters with splits at various points."""

        def byte_gen() -> list[bytes]:
            # "café" in UTF-8: c a f [0xC3 0xA9] - the é is 2 bytes
            text = "data: café résumé"
            encoded = text.encode("utf-8")
            # Split in the middle of the first é
            split_point = 10  # After "data: caf" and first byte of é
            return [
                b"event: data\n",
                encoded[:split_point],
                encoded[split_point:] + b"\n",
                b"\n",
            ]

        events = list(parse_sse_sync(iter(byte_gen())))
        assert len(events) == 1
        assert events[0].data == "café résumé"  # type: ignore[union-attr]
