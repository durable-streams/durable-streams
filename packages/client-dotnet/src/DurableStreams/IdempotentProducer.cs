using System.Buffers;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DurableStreams.Internal;

namespace DurableStreams;

/// <summary>
/// Fire-and-forget producer with exactly-once write semantics.
/// Thread-safe for concurrent Append calls.
/// </summary>
public sealed class IdempotentProducer : IAsyncDisposable
{
    private readonly DurableStream _stream;
    private readonly string _producerId;
    private readonly IdempotentProducerOptions _options;
    private readonly SemaphoreSlim _flushLock = new(1, 1);
    private readonly object _stateLock = new();

    private int _epoch;
    private int _nextSeq;
    private int _inFlight;
    private bool _closed;
    private bool _epochClaimed;
    private Timer? _lingerTimer;
    private List<PendingMessage> _pendingBatch = [];
    private int _batchBytes;

    // Sequence completion tracking for 409 retry coordination
    private readonly Dictionary<(int epoch, int seq), TaskCompletionSource<Exception?>> _seqCompletion = [];

    /// <summary>
    /// Current epoch.
    /// </summary>
    public int Epoch => _epoch;

    /// <summary>
    /// Next sequence number to be assigned.
    /// </summary>
    public int NextSeq => _nextSeq;

    /// <summary>
    /// Number of messages in the current pending batch.
    /// </summary>
    public int PendingCount
    {
        get
        {
            lock (_stateLock)
            {
                return _pendingBatch.Count;
            }
        }
    }

    /// <summary>
    /// Number of batches currently in flight.
    /// </summary>
    public int InFlightCount => _inFlight;

    /// <summary>
    /// Event raised when a batch error occurs.
    /// </summary>
    public event EventHandler<ProducerErrorEventArgs>? OnError;

    internal IdempotentProducer(DurableStream stream, string producerId, IdempotentProducerOptions options)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
        _producerId = producerId ?? throw new ArgumentNullException(nameof(producerId));
        _options = options ?? throw new ArgumentNullException(nameof(options));

        // Validate options
        if (options.Epoch < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "epoch must be non-negative");
        }
        if (options.MaxBatchBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "maxBatchBytes must be positive");
        }

        _epoch = options.Epoch;
        _nextSeq = 0;

        // Set content type on stream if specified
        if (options.ContentType != null)
        {
            _stream.ContentType = options.ContentType;
        }
    }

    /// <summary>
    /// Append data (fire-and-forget). Returns immediately.
    /// </summary>
    public void Append(ReadOnlyMemory<byte> data)
    {
        AppendInternal(data, null);
    }

    /// <summary>
    /// Append JSON-serializable data (fire-and-forget).
    /// </summary>
    public void Append<T>(T data)
    {
        // Serialize once to UTF8 bytes - DoSendBatchAsync uses WriteRawValue for these
        var jsonOptions = _stream.Client.Options.JsonSerializerOptions;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(data, jsonOptions);
        AppendInternal(bytes, null);
    }

    /// <summary>
    /// Append string data (fire-and-forget).
    /// </summary>
    public void Append(string data)
    {
        var bytes = Encoding.UTF8.GetBytes(data);
        AppendInternal(bytes, null);
    }

    /// <summary>
    /// Attempt to append data without blocking.
    /// </summary>
    public bool TryAppend(ReadOnlyMemory<byte> data)
    {
        return TryAppendInternal(data, null);
    }

    /// <summary>
    /// Attempt to append JSON data without blocking.
    /// </summary>
    public bool TryAppend<T>(T data)
    {
        // Serialize once to UTF8 bytes - DoSendBatchAsync uses WriteRawValue for these
        var jsonOptions = _stream.Client.Options.JsonSerializerOptions;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(data, jsonOptions);
        return TryAppendInternal(bytes, null);
    }

    private void AppendInternal(ReadOnlyMemory<byte> data, JsonElement? jsonData)
    {
        if (_closed)
        {
            throw new DurableStreamException("Producer is closed",
                DurableStreamErrorCode.AlreadyClosed, null, _stream.Url);
        }

        lock (_stateLock)
        {
            var message = new PendingMessage(data, jsonData);
            _pendingBatch.Add(message);
            _batchBytes += data.Length;

            // Check if batch should send
            var shouldSend = _batchBytes >= _options.MaxBatchBytes;
            // Only start timer if Linger > 0 (Linger <= 0 means batch by size only)
            var shouldStartTimer = !shouldSend && _lingerTimer == null && _pendingBatch.Count == 1 && _options.Linger > TimeSpan.Zero;

            if (shouldSend)
            {
                SendCurrentBatchLocked();
            }
            else if (shouldStartTimer)
            {
                _lingerTimer = new Timer(
                    _ => OnLingerTimerExpired(),
                    null,
                    _options.Linger,
                    Timeout.InfiniteTimeSpan);
            }
        }
    }

    private bool TryAppendInternal(ReadOnlyMemory<byte> data, JsonElement? jsonData)
    {
        if (_closed) return false;

        lock (_stateLock)
        {
            if (_pendingBatch.Count >= _options.MaxBufferedMessages)
                return false;
            if (_batchBytes + data.Length > _options.MaxBufferedBytes)
                return false;

            var message = new PendingMessage(data, jsonData);
            _pendingBatch.Add(message);
            _batchBytes += data.Length;

            var shouldSend = _batchBytes >= _options.MaxBatchBytes;
            // Only start timer if Linger > 0 (Linger <= 0 means batch by size only)
            var shouldStartTimer = !shouldSend && _lingerTimer == null && _pendingBatch.Count == 1 && _options.Linger > TimeSpan.Zero;

            if (shouldSend)
            {
                SendCurrentBatchLocked();
            }
            else if (shouldStartTimer)
            {
                _lingerTimer = new Timer(
                    _ => OnLingerTimerExpired(),
                    null,
                    _options.Linger,
                    Timeout.InfiniteTimeSpan);
            }

            return true;
        }
    }

    private void OnLingerTimerExpired()
    {
        lock (_stateLock)
        {
            _lingerTimer?.Dispose();
            _lingerTimer = null;

            if (_pendingBatch.Count > 0)
            {
                SendCurrentBatchLocked();
            }
        }
    }

    private void SendCurrentBatchLocked()
    {
        if (_pendingBatch.Count == 0) return;

        // Check in-flight limit
        if (_inFlight >= _options.MaxInFlight) return;

        // When autoClaim, wait for first batch to complete before pipelining
        if (_options.AutoClaim && !_epochClaimed && _inFlight > 0) return;

        var batch = _pendingBatch;
        var seq = _nextSeq;
        var epoch = _epoch;

        _pendingBatch = [];
        _batchBytes = 0;
        _nextSeq++;
        Interlocked.Increment(ref _inFlight);

        _lingerTimer?.Dispose();
        _lingerTimer = null;

        // Fire-and-forget: start async operation without Task.Run overhead
        // The async method returns immediately at first await, releasing the lock
        _ = SendBatchFireAndForgetAsync(batch, seq, epoch);
    }

    private async Task SendBatchFireAndForgetAsync(List<PendingMessage> batch, int seq, int epoch)
    {
        Exception? error = null;
        try
        {
            await DoSendBatchAsync(batch, seq, epoch, CancellationToken.None).ConfigureAwait(false);
            lock (_stateLock)
            {
                _epochClaimed = true;
            }
        }
        catch (Exception ex)
        {
            error = ex;
            RaiseError(ex, epoch, seq, seq, batch.Count);
        }
        finally
        {
            Interlocked.Decrement(ref _inFlight);
            SignalSeqComplete(epoch, seq, error);

            // Check if more to send
            lock (_stateLock)
            {
                if (_pendingBatch.Count > 0 && _inFlight < _options.MaxInFlight)
                {
                    SendCurrentBatchLocked();
                }
            }
        }
    }

    private async Task DoSendBatchAsync(List<PendingMessage> batch, int seq, int epoch, CancellationToken cancellationToken)
    {
        var isJson = HttpHelpers.IsJsonContentType(_stream.ContentType ?? _options.ContentType);
        byte[]? rentedBuffer = null;
        int bodyLength;

        try
        {
            if (isJson)
            {
                // JSON: send as array (server flattens one level)
                // Use Utf8JsonWriter for efficient direct-to-bytes serialization
                using var ms = new MemoryStream();
                using (var writer = new Utf8JsonWriter(ms))
                {
                    writer.WriteStartArray();
                    foreach (var msg in batch)
                    {
                        if (msg.JsonData.HasValue)
                        {
                            msg.JsonData.Value.WriteTo(writer);
                        }
                        else
                        {
                            // Raw bytes - write as raw JSON
                            writer.WriteRawValue(msg.Data.Span);
                        }
                    }
                    writer.WriteEndArray();
                }
                // For JSON, copy from MemoryStream to pooled buffer
                bodyLength = (int)ms.Length;
                rentedBuffer = ArrayPool<byte>.Shared.Rent(bodyLength);
                ms.Position = 0;
                ms.Read(rentedBuffer, 0, bodyLength);
            }
            else
            {
                // Bytes: concatenate into pooled buffer
                var totalSize = batch.Sum(m => m.Data.Length);
                rentedBuffer = ArrayPool<byte>.Shared.Rent(totalSize);
                bodyLength = totalSize;
                var offset = 0;
                foreach (var msg in batch)
                {
                    msg.Data.Span.CopyTo(rentedBuffer.AsSpan(offset));
                    offset += msg.Data.Length;
                }
            }

            using var request = new HttpRequestMessage(HttpMethod.Post, _stream.Url);
            await _stream.Client.ApplyDefaultHeadersAsync(request, cancellationToken).ConfigureAwait(false);

            var contentType = _stream.ContentType ?? _options.ContentType ?? ContentTypes.OctetStream;
            request.Content = new ByteArrayContent(rentedBuffer, 0, bodyLength);
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);

            request.Headers.TryAddWithoutValidation(Headers.ProducerId, _producerId);
            request.Headers.TryAddWithoutValidation(Headers.ProducerEpoch, epoch.ToString());
            request.Headers.TryAddWithoutValidation(Headers.ProducerSeq, seq.ToString());

            using var response = await _stream.Client.HttpClient
                .SendAsync(request, cancellationToken)
                .ConfigureAwait(false);

            var statusCode = response.StatusCode;

            switch (statusCode)
            {
                case HttpStatusCode.OK:
                case HttpStatusCode.NoContent:
                    return;

                case HttpStatusCode.Forbidden:
                    var currentEpoch = HttpHelpers.GetIntHeader(response, Headers.ProducerEpoch) ?? epoch;

                    if (_options.AutoClaim)
                    {
                        var newEpoch = currentEpoch + 1;
                        lock (_stateLock)
                        {
                            _epoch = newEpoch;
                            _nextSeq = 1;
                        }
                        await DoSendBatchAsync(batch, 0, newEpoch, cancellationToken).ConfigureAwait(false);
                        return;
                    }

                    throw new StaleEpochException(currentEpoch, _stream.Url);

                case HttpStatusCode.Conflict:
                    var expectedSeq = HttpHelpers.GetIntHeader(response, Headers.ProducerExpectedSeq) ?? 0;
                    var receivedSeq = HttpHelpers.GetIntHeader(response, Headers.ProducerReceivedSeq) ?? seq;

                    if (expectedSeq < seq)
                    {
                        for (var s = expectedSeq; s < seq; s++)
                        {
                            var error = await WaitForSeqAsync(epoch, s, cancellationToken).ConfigureAwait(false);
                            if (error != null)
                            {
                                throw error;
                            }
                        }
                        await DoSendBatchAsync(batch, seq, epoch, cancellationToken).ConfigureAwait(false);
                        return;
                    }

                    throw new SequenceGapException(expectedSeq, receivedSeq, _stream.Url);

                case HttpStatusCode.NotFound:
                    throw new StreamNotFoundException(_stream.Url);

                default:
                    var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    throw DurableStreamException.FromStatusCode((int)statusCode, _stream.Url, body);
            }
        }
        finally
        {
            // Return pooled buffer
            if (rentedBuffer != null)
            {
                ArrayPool<byte>.Shared.Return(rentedBuffer);
            }
        }
    }

    private void SignalSeqComplete(int epoch, int seq, Exception? error)
    {
        TaskCompletionSource<Exception?>? tcs;
        lock (_seqCompletion)
        {
            if (_seqCompletion.TryGetValue((epoch, seq), out tcs))
            {
                _seqCompletion.Remove((epoch, seq));
            }
        }
        tcs?.TrySetResult(error);
    }

    private async Task<Exception?> WaitForSeqAsync(int epoch, int seq, CancellationToken cancellationToken)
    {
        TaskCompletionSource<Exception?> tcs;
        lock (_seqCompletion)
        {
            if (!_seqCompletion.TryGetValue((epoch, seq), out tcs!))
            {
                tcs = new TaskCompletionSource<Exception?>();
                _seqCompletion[(epoch, seq)] = tcs;
            }
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(30)); // Timeout

        try
        {
            return await tcs.Task.WaitAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return new DurableStreamException("Timeout waiting for sequence",
                DurableStreamErrorCode.Timeout, null, _stream.Url);
        }
    }

    private void RaiseError(Exception ex, int epoch, int startSeq, int endSeq, int messageCount)
    {
        var isRetryable = ex is DurableStreamException dse &&
            (dse.Code == DurableStreamErrorCode.NetworkError ||
             dse.Code == DurableStreamErrorCode.RateLimited ||
             (dse.StatusCode >= 500 && dse.StatusCode < 600));

        OnError?.Invoke(this, new ProducerErrorEventArgs
        {
            Exception = ex,
            IsRetryable = isRetryable,
            Epoch = epoch,
            SequenceRange = (startSeq, endSeq),
            MessageCount = messageCount
        });
    }

    /// <summary>
    /// Flush pending batches and wait for all in-flight batches.
    /// </summary>
    public async Task FlushAsync(CancellationToken cancellationToken = default)
    {
        await _flushLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            while (true)
            {
                lock (_stateLock)
                {
                    // Cancel linger timer
                    _lingerTimer?.Dispose();
                    _lingerTimer = null;

                    // Send any pending
                    if (_pendingBatch.Count > 0)
                    {
                        SendCurrentBatchLocked();
                    }

                    if (_pendingBatch.Count == 0 && _inFlight == 0)
                    {
                        return;
                    }
                }

                // Wait a bit and check again
                await Task.Delay(10, cancellationToken).ConfigureAwait(false);
            }
        }
        finally
        {
            _flushLock.Release();
        }
    }

    /// <summary>
    /// Increment epoch and reset sequence (for restart scenarios).
    /// </summary>
    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        await FlushAsync(cancellationToken).ConfigureAwait(false);

        lock (_stateLock)
        {
            _epoch++;
            _nextSeq = 0;
            _epochClaimed = false;
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_closed) return;
        _closed = true;

        try
        {
            await FlushAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Log flush errors during dispose - data may have been lost
            System.Diagnostics.Debug.WriteLine(
                $"[DurableStreams] IdempotentProducer flush failed during dispose: {ex.Message}. " +
                $"Pending messages may not have been delivered.");
            // Also raise OnError so subscribers are notified
            RaiseError(ex, _epoch, _nextSeq - 1, _nextSeq - 1, _pendingBatch.Count);
        }

        _lingerTimer?.Dispose();
        _flushLock.Dispose();
    }

    private readonly record struct PendingMessage(ReadOnlyMemory<byte> Data, JsonElement? JsonData);
}
