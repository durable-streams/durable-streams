<?php

declare(strict_types=1);

namespace DurableStreams\Internal;

use DurableStreams\Exception\DurableStreamException;

/**
 * SSE event types.
 */
enum SSEEventType: string
{
    case Data = 'data';
    case Control = 'control';
}

/**
 * Represents a parsed SSE event.
 */
final class SSEEvent
{
    public function __construct(
        public readonly SSEEventType $type,
        public readonly ?string $data = null,
        public readonly ?string $streamNextOffset = null,
        public readonly ?string $streamCursor = null,
        public readonly bool $upToDate = false,
    ) {}
}

/**
 * Parser for Server-Sent Events streams.
 *
 * Parses SSE events according to the Durable Streams protocol:
 * - `event: data` events contain the stream data
 * - `event: control` events contain `streamNextOffset` and optional `streamCursor` and `upToDate`
 */
final class SSEParser
{
    /** @var resource|SSEStreamHandle */
    private $stream;
    private bool $isSSEHandle;
    private string $buffer = '';
    private string $currentEventType = '';
    /** @var array<string> */
    private array $currentDataLines = [];

    /**
     * @param resource|SSEStreamHandle $stream
     */
    public function __construct($stream)
    {
        $this->stream = $stream;
        $this->isSSEHandle = $stream instanceof SSEStreamHandle;
    }

    /**
     * Read data from the stream.
     *
     * @return string|false Data read, or false on EOF
     */
    private function readChunk(): string|false
    {
        if ($this->isSSEHandle) {
            /** @var SSEStreamHandle $handle */
            $handle = $this->stream;
            return $handle->read(8192);
        }

        // Legacy resource-based read
        return fread($this->stream, 8192);
    }

    /**
     * Check if stream is at EOF.
     */
    private function isEof(): bool
    {
        if ($this->isSSEHandle) {
            /** @var SSEStreamHandle $handle */
            $handle = $this->stream;
            return $handle->eof();
        }

        return feof($this->stream);
    }

    /**
     * Parse the next SSE event from the stream.
     *
     * @return SSEEvent|null Returns null on EOF or when no complete event is available
     * @throws DurableStreamException If a control event cannot be parsed
     */
    public function next(): ?SSEEvent
    {
        while (true) {
            // Process any complete events already in the buffer before reading more
            // This is critical when the previous next() call left unconsumed data
            if ($this->buffer !== '') {
                // Normalize line endings: CRLF -> LF, lone CR -> LF
                $this->buffer = str_replace(["\r\n", "\r"], "\n", $this->buffer);

                while (($pos = strpos($this->buffer, "\n")) !== false) {
                    $line = substr($this->buffer, 0, $pos);
                    $this->buffer = substr($this->buffer, $pos + 1);

                    if ($line === '') {
                        $event = $this->flushEvent();
                        if ($event !== null) {
                            return $event;
                        }
                        continue;
                    }

                    if (str_starts_with($line, 'event:')) {
                        $this->currentEventType = trim(substr($line, 6));
                    } elseif (str_starts_with($line, 'data:')) {
                        $content = substr($line, 5);
                        if (str_starts_with($content, ' ')) {
                            $content = substr($content, 1);
                        }
                        $this->currentDataLines[] = $content;
                    }
                }
            }

            // Try to read more data
            $chunk = $this->readChunk();
            if ($chunk === false || ($chunk === '' && $this->isEof())) {
                // EOF - try to flush any remaining event
                $event = $this->flushEvent();
                return $event;
            }

            if ($chunk !== '') {
                $this->buffer .= $chunk;
            }

            // Normalize line endings: CRLF -> LF, lone CR -> LF
            $this->buffer = str_replace(["\r\n", "\r"], "\n", $this->buffer);

            // Process complete lines
            while (($pos = strpos($this->buffer, "\n")) !== false) {
                $line = substr($this->buffer, 0, $pos);
                $this->buffer = substr($this->buffer, $pos + 1);

                if ($line === '') {
                    // Empty line signals end of event
                    $event = $this->flushEvent();
                    if ($event !== null) {
                        return $event;
                    }
                    continue;
                }

                if (str_starts_with($line, 'event:')) {
                    $this->currentEventType = trim(substr($line, 6));
                } elseif (str_starts_with($line, 'data:')) {
                    // Per SSE spec, strip the optional space after "data:"
                    $content = substr($line, 5);
                    if (str_starts_with($content, ' ')) {
                        $content = substr($content, 1);
                    }
                    $this->currentDataLines[] = $content;
                }
                // Ignore other fields (id:, retry:, comments starting with :)
            }

            // If we have no complete event and can't read more, wait
            if ($chunk === '' && !$this->isEof()) {
                // Non-blocking check - might need to wait for more data
                usleep(1000); // 1ms delay to avoid busy-waiting
                continue;
            }

            // If EOF and no complete event yet, return what we have
            if ($this->isEof()) {
                return $this->flushEvent();
            }
        }
    }

    /**
     * Flush the current event buffer and return an event if valid.
     */
    private function flushEvent(): ?SSEEvent
    {
        $eventType = $this->currentEventType;

        // Reset state
        $this->currentEventType = '';
        $dataLines = $this->currentDataLines;
        $this->currentDataLines = [];

        // For non-control events, require data
        if ($eventType === '') {
            return null;
        }

        // For data events, skip if no data
        if ($eventType === 'data' && count($dataLines) === 0) {
            return null;
        }

        $dataStr = implode("\n", $dataLines);

        switch ($eventType) {
            case 'data':
                return new SSEEvent(
                    type: SSEEventType::Data,
                    data: $dataStr,
                );

            case 'control':
                // Control events must be valid JSON
                $control = json_decode($dataStr, true);
                if ($control === null && json_last_error() !== JSON_ERROR_NONE) {
                    $preview = strlen($dataStr) > 100 ? substr($dataStr, 0, 100) . '...' : $dataStr;
                    throw new DurableStreamException(
                        "Failed to parse SSE control event: " . json_last_error_msg() . ". Data: $preview",
                        'PARSE_ERROR'
                    );
                }

                return new SSEEvent(
                    type: SSEEventType::Control,
                    streamNextOffset: $control['streamNextOffset'] ?? null,
                    streamCursor: $control['streamCursor'] ?? null,
                    upToDate: $control['upToDate'] ?? false,
                );

            default:
                // Unknown event type, skip (per protocol spec)
                return null;
        }
    }
}
