<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Exception\MessageTooLargeException;
use DurableStreams\Exception\SeqConflictException;
use DurableStreams\Exception\StaleEpochException;
use DurableStreams\Internal\HttpClient;
use DurableStreams\Internal\HttpClientInterface;
use Psr\Log\LoggerInterface;

/**
 * Idempotent producer with exactly-once semantics.
 *
 * Exactly-once delivery is achieved via Producer-Id, Producer-Epoch, and Producer-Seq
 * headers which allow the server to detect and deduplicate messages.
 *
 * Uses local batching for efficiency. Items are queued locally via enqueue()
 * and sent when flush() is called or batch size limits are reached.
 *
 * **PHP Limitations vs other clients:**
 * - No `lingerMs` (auto-flush timer) - PHP has no background threads, so batches
 *   only flush on size limits or explicit flush() call
 * - No `maxInFlight` (pipelining) - batches are sent synchronously, not concurrently
 */
final class IdempotentProducer
{
    private int $epoch;
    private int $nextSeq = 0;

    /** @var array<array{data: mixed, seq: int, epoch: int}> */
    private array $pendingBatches = [];

    /** @var array<mixed> */
    private array $currentBatch = [];
    private int $currentBatchSize = 0;

    private HttpClientInterface $client;
    private ?string $contentType;
    private int $maxBatchBytes;
    private int $maxBatchItems;
    private bool $autoClaim;
    private ?LoggerInterface $logger;

    /**
     * @param string $url Stream URL
     * @param string $producerId Unique producer identifier
     * @param int $epoch Starting epoch
     * @param bool $autoClaim Auto-claim epoch on 403
     * @param int $maxBatchBytes Maximum batch size in bytes
     * @param int $maxBatchItems Maximum items per batch
     * @param string|null $contentType Content type (auto-detected if not provided)
     * @param HttpClientInterface|null $client HTTP client
     * @param LoggerInterface|null $logger PSR-3 logger for diagnostic messages
     */
    public function __construct(
        private readonly string $url,
        private readonly string $producerId,
        int $epoch = 0,
        bool $autoClaim = false,
        int $maxBatchBytes = 1024 * 1024,
        int $maxBatchItems = 1000,
        ?string $contentType = null,
        ?HttpClientInterface $client = null,
        ?LoggerInterface $logger = null,
    ) {
        if ($epoch < 0) {
            throw new \InvalidArgumentException('epoch must be >= 0');
        }
        if ($maxBatchBytes <= 0) {
            throw new \InvalidArgumentException('maxBatchBytes must be > 0');
        }
        if ($maxBatchItems <= 0) {
            throw new \InvalidArgumentException('maxBatchItems must be > 0');
        }

        $this->epoch = $epoch;
        $this->autoClaim = $autoClaim;
        $this->maxBatchBytes = $maxBatchBytes;
        $this->maxBatchItems = $maxBatchItems;
        $this->contentType = $contentType;
        $this->client = $client ?? new HttpClient();
        $this->logger = $logger;
    }

    /**
     * Queue data locally for batched sending.
     *
     * Returns immediately - no network I/O performed.
     * Auto-flushes if batch size limit reached.
     *
     * @param mixed $data Data to append (arrays/objects are JSON-encoded)
     * @throws MessageTooLargeException if single item exceeds maxBatchBytes
     */
    public function enqueue(mixed $data): void
    {
        // Calculate size
        if (is_string($data)) {
            $size = strlen($data);
        } else {
            $size = strlen(json_encode($data, JSON_THROW_ON_ERROR));
        }

        // Reject single items that exceed max batch size
        if ($size > $this->maxBatchBytes) {
            throw new MessageTooLargeException($size, $this->maxBatchBytes);
        }

        // Auto-flush if batch would exceed limits
        if (
            ($this->currentBatchSize + $size > $this->maxBatchBytes) ||
            (count($this->currentBatch) >= $this->maxBatchItems)
        ) {
            $this->flush();
        }

        $this->currentBatch[] = $data;
        $this->currentBatchSize += $size;
    }

    /**
     * Send all queued batches to server.
     *
     * Blocks until all HTTP requests complete.
     *
     * @throws DurableStreamException on network or protocol errors
     */
    public function flush(): void
    {
        $this->flushCurrentBatch();
        $this->sendAllBatches();
    }

    /**
     * Move current batch to pending batches.
     */
    private function flushCurrentBatch(): void
    {
        if (empty($this->currentBatch)) {
            return;
        }

        $this->pendingBatches[] = [
            'data' => $this->currentBatch,
            'seq' => $this->nextSeq++,
            'epoch' => $this->epoch,
        ];

        $this->currentBatch = [];
        $this->currentBatchSize = 0;
    }

    /**
     * Send all pending batches synchronously.
     */
    private function sendAllBatches(): void
    {
        while (!empty($this->pendingBatches)) {
            $batch = array_shift($this->pendingBatches);
            $this->sendBatch($batch);
        }
    }

    /**
     * Send a single batch with retry logic.
     *
     * @param array{data: mixed, seq: int, epoch: int} $batch
     */
    private function sendBatch(array $batch): void
    {
        $maxAttempts = 3;
        $lastException = null;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $this->doSend($batch);
                return;
            } catch (DurableStreamException $e) {
                $lastException = $e;

                // Handle stale epoch
                if ($e->getHttpStatus() === 403) {
                    $headers = $e->getHeaders();
                    $currentEpoch = $this->parseEpochHeader($headers);

                    if ($this->autoClaim) {
                        $newEpoch = $currentEpoch + 1;
                        $this->epoch = $newEpoch;

                        // Update current batch to use new epoch with seq 0
                        $batch['epoch'] = $newEpoch;
                        $batch['seq'] = 0;

                        // Rebase all remaining pending batches to new epoch
                        // Sequences start at 1 since current batch uses seq 0
                        $nextSeq = 1;
                        foreach ($this->pendingBatches as &$pending) {
                            $pending['epoch'] = $newEpoch;
                            $pending['seq'] = $nextSeq++;
                        }
                        unset($pending);

                        $this->nextSeq = $nextSeq;
                        continue;
                    }

                    throw new StaleEpochException($currentEpoch, $e);
                }

                // Handle sequence conflict
                if ($e instanceof SeqConflictException) {
                    $this->handleSeqConflict($e, $batch);
                    return;
                }

                // Other errors - rethrow
                throw $e;
            }
        }

        throw new DurableStreamException(
            sprintf(
                'Failed to send batch after %d attempts. Last error: %s',
                $maxAttempts,
                $lastException?->getMessage() ?? 'unknown'
            ),
            'MAX_RETRIES_EXCEEDED',
            $lastException?->getHttpStatus(),
            [],
            $lastException
        );
    }

    /**
     * Handle sequence conflict exception.
     *
     * A 409 with sequence conflict can mean:
     * - receivedSeq <= expectedSeq-1: true duplicate, safe to ignore (server already has this data)
     * - receivedSeq > expectedSeq: sequence gap, data loss risk - throw error
     *
     * @param SeqConflictException $e
     * @param array{data: mixed, seq: int, epoch: int} $batch
     */
    private function handleSeqConflict(SeqConflictException $e, array $batch): void
    {
        $expectedSeq = $e->getExpectedSeq();
        $receivedSeq = $e->getReceivedSeq();

        // If we have both values, we can determine if this is a true duplicate
        if ($expectedSeq !== null && $receivedSeq !== null) {
            // If expected > received, server is ahead of us - this is a duplicate
            // (server already processed higher sequences)
            if ($expectedSeq > $receivedSeq) {
                $this->logger?->debug('SeqConflict: duplicate detected', [
                    'producer' => $this->producerId,
                    'epoch' => $batch['epoch'],
                    'seq' => $batch['seq'],
                    'expected' => $expectedSeq,
                ]);
                return;
            }

            // If received > expected, we skipped sequences - this is a gap, data may be lost
            // This shouldn't happen in PHP's synchronous model, but if it does, throw
            throw new DurableStreamException(
                sprintf(
                    'Sequence gap detected: expected seq %d but sent seq %d. Possible data loss.',
                    $expectedSeq,
                    $receivedSeq
                ),
                'SEQUENCE_GAP',
                409,
                $e->getHeaders()
            );
        }

        // If we don't have enough info, treat conservatively as duplicate
        // Log warning as this indicates incomplete protocol implementation
        $this->logger?->warning('SeqConflict with incomplete headers, treating as duplicate', [
            'producer' => $this->producerId,
            'epoch' => $batch['epoch'],
            'seq' => $batch['seq'],
        ]);
    }

    /**
     * Parse epoch from response headers with warning on missing header.
     *
     * @param array<string, string> $headers
     */
    private function parseEpochHeader(array $headers): int
    {
        if (isset($headers['producer-epoch'])) {
            return (int) $headers['producer-epoch'];
        }

        $this->logger?->warning('403 response missing producer-epoch header. Server may not be protocol-compliant.', [
            'producer' => $this->producerId,
        ]);
        return $this->epoch;
    }

    /**
     * Actually send the batch.
     *
     * @param array{data: mixed, seq: int, epoch: int} $batch
     */
    private function doSend(array $batch): void
    {
        $headers = [
            'Producer-Id' => $this->producerId,
            'Producer-Epoch' => (string)$batch['epoch'],
            'Producer-Seq' => (string)$batch['seq'],
        ];

        // Determine content type
        $contentType = $this->contentType ?? 'application/json';
        $headers['Content-Type'] = $contentType;

        // Encode data based on content type
        $data = $batch['data'];
        $isJson = str_contains($contentType, 'json');

        if (is_array($data)) {
            if ($isJson) {
                // JSON content: encode as JSON array
                $body = json_encode($data, JSON_THROW_ON_ERROR);
            } else {
                // Non-JSON content: concatenate string items
                $body = implode('', array_map('strval', $data));
            }
        } else {
            $body = (string)$data;
        }

        $this->client->post($this->url, $body, $headers);
    }

    /**
     * Increment epoch and reset sequence (zombie fencing).
     */
    public function restart(): void
    {
        $this->flush();
        $this->epoch++;
        $this->nextSeq = 0;
    }

    /**
     * Get current epoch.
     */
    public function getEpoch(): int
    {
        return $this->epoch;
    }

    /**
     * Get current sequence number.
     */
    public function getSeq(): int
    {
        return $this->nextSeq;
    }

    /**
     * Flush and close.
     */
    public function close(): void
    {
        $this->flush();
    }
}
