<?php

declare(strict_types=1);

namespace DurableStreams;

use DurableStreams\Exception\DurableStreamException;
use DurableStreams\Exception\MessageTooLargeException;
use DurableStreams\Exception\SeqConflictException;
use DurableStreams\Exception\StaleEpochException;
use DurableStreams\Internal\HttpClient;
use DurableStreams\Internal\HttpClientInterface;

/**
 * Idempotent producer with exactly-once semantics.
 *
 * Uses local batching for efficiency. Items are queued locally via enqueue()
 * and sent when flush() is called or batch size limits are reached.
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

    /**
     * @param string $url Stream URL
     * @param string $producerId Unique producer identifier
     * @param int $epoch Starting epoch
     * @param bool $autoClaim Auto-claim epoch on 403
     * @param int $maxBatchBytes Maximum batch size in bytes
     * @param int $maxBatchItems Maximum items per batch
     * @param string|null $contentType Content type (auto-detected if not provided)
     * @param HttpClientInterface|null $client HTTP client
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
    ) {
        $this->epoch = $epoch;
        $this->autoClaim = $autoClaim;
        $this->maxBatchBytes = $maxBatchBytes;
        $this->maxBatchItems = $maxBatchItems;
        $this->contentType = $contentType;
        $this->client = $client ?? new HttpClient();
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

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            try {
                $this->doSend($batch);
                return;
            } catch (DurableStreamException $e) {
                // Handle stale epoch
                if ($e->getHttpStatus() === 403) {
                    if ($this->autoClaim) {
                        // Parse current epoch from response headers
                        $headers = $e->getHeaders();
                        $currentEpoch = isset($headers['producer-epoch'])
                            ? (int)$headers['producer-epoch']
                            : $this->epoch;

                        $this->epoch = $currentEpoch + 1;
                        $batch['epoch'] = $this->epoch;
                        $batch['seq'] = 0;
                        $this->nextSeq = 1;
                        continue;
                    }

                    $headers = $e->getHeaders();
                    $currentEpoch = isset($headers['producer-epoch'])
                        ? (int)$headers['producer-epoch']
                        : $this->epoch;

                    throw new StaleEpochException($currentEpoch, $e);
                }

                // Handle sequence conflict (duplicate detection)
                if ($e instanceof SeqConflictException) {
                    // Batch already delivered, safe to continue
                    return;
                }

                // Other errors - rethrow
                throw $e;
            }
        }

        throw new DurableStreamException(
            "Failed to send batch after {$maxAttempts} attempts",
            'MAX_RETRIES_EXCEEDED'
        );
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
