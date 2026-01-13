using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using DurableStreams.Internal;
using DurableStreams.Sse;

namespace DurableStreams;

/// <summary>
/// A streaming read session with multiple consumption patterns.
/// IMPORTANT: This is a single-consumer abstraction. Only call ONE Read* method
/// per response instance.
/// </summary>
public sealed class StreamResponse : IAsyncDisposable
{
    private readonly DurableStream _stream;
    private readonly StreamOptions _options;
    private readonly CancellationToken _cancellationToken;
    private readonly CancellationTokenSource _cts;

    private HttpResponseMessage? _currentResponse;
    private SseParser? _sseParser;
    private string _url;
    private Offset _offset;
    private string? _cursor;
    private bool _upToDate;
    private bool _initialized;
    private bool _disposed;
    private bool _consumed;

    // Pending SSE data (data event received, waiting for control)
    private string? _pendingSseData;

    // SSE reconnection backoff state
    private int _sseReconnectAttempts;

    /// <summary>
    /// The stream URL.
    /// </summary>
    public string Url => _stream.Url;

    /// <summary>
    /// The content type.
    /// </summary>
    public string? ContentType => _stream.ContentType;

    /// <summary>
    /// The live mode.
    /// </summary>
    public LiveMode Live => _options.Live;

    /// <summary>
    /// The starting offset.
    /// </summary>
    public Offset StartOffset { get; private set; }

    /// <summary>
    /// Current offset (advances as data is consumed).
    /// </summary>
    public Offset Offset => _offset;

    /// <summary>
    /// Current checkpoint (offset + cursor for resumption).
    /// </summary>
    public StreamCheckpoint Checkpoint => new(_offset, _cursor);

    /// <summary>
    /// Whether we've reached the current end of stream.
    /// </summary>
    public bool UpToDate => _upToDate;

    internal StreamResponse(
        DurableStream stream,
        StreamOptions options,
        string url,
        CancellationToken cancellationToken)
    {
        _stream = stream;
        _options = options;
        _url = url;
        _offset = options.Offset ?? Offset.Beginning;
        _cursor = options.Cursor;
        _cancellationToken = cancellationToken;
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        StartOffset = _offset;
    }

    /// <summary>
    /// Initialize the response by making the first request.
    /// </summary>
    internal async Task InitializeAsync()
    {
        if (_initialized) return;
        _initialized = true;

        await MakeRequestAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Stream raw byte chunks as they arrive.
    /// </summary>
    public async IAsyncEnumerable<ByteChunk> ReadBytesAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ThrowIfConsumed();
        _consumed = true;

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
        var token = linkedCts.Token;

        while (!_disposed && !token.IsCancellationRequested)
        {
            var chunk = await ReadNextChunkAsync(token).ConfigureAwait(false);

            if (chunk == null)
            {
                // End of stream or caught up in non-live mode
                break;
            }

            yield return chunk.Value;

            if (_upToDate && _options.Live == LiveMode.Off)
            {
                break;
            }
        }
    }

    /// <summary>
    /// Stream JSON batches with metadata as they arrive.
    /// </summary>
    public async IAsyncEnumerable<JsonBatch<T>> ReadJsonBatchesAsync<T>(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var chunk in ReadBytesAsync(cancellationToken).ConfigureAwait(false))
        {
            if (chunk.Data.IsEmpty)
            {
                yield return new JsonBatch<T>([], chunk.Checkpoint, chunk.UpToDate);
                continue;
            }

            var items = ParseJsonBatch<T>(chunk.Data.Span);
            yield return new JsonBatch<T>(items, chunk.Checkpoint, chunk.UpToDate);
        }
    }

    /// <summary>
    /// Stream individual JSON items as they arrive.
    /// </summary>
    public async IAsyncEnumerable<T> ReadJsonAsync<T>(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var batch in ReadJsonBatchesAsync<T>(cancellationToken).ConfigureAwait(false))
        {
            foreach (var item in batch.Items)
            {
                yield return item;
            }
        }
    }

    /// <summary>
    /// Stream text chunks as they arrive.
    /// </summary>
    public async IAsyncEnumerable<TextChunk> ReadTextAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var chunk in ReadBytesAsync(cancellationToken).ConfigureAwait(false))
        {
            var text = chunk.Data.IsEmpty ? "" : Encoding.UTF8.GetString(chunk.Data.Span);
            yield return new TextChunk(text, chunk.Checkpoint, chunk.UpToDate);
        }
    }

    /// <summary>
    /// Accumulate all bytes until upToDate, then return.
    /// Only valid with LiveMode.Off; throws InvalidOperationException for live modes.
    /// </summary>
    public async Task<byte[]> ReadAllBytesAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfLiveMode();
        using var ms = new MemoryStream();
        await foreach (var chunk in ReadBytesAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!chunk.Data.IsEmpty)
            {
                ms.Write(chunk.Data.Span);
            }
        }
        return ms.ToArray();
    }

    /// <summary>
    /// Accumulate all JSON items until upToDate, then return.
    /// Only valid with LiveMode.Off; throws InvalidOperationException for live modes.
    /// </summary>
    public async Task<List<T>> ReadAllJsonAsync<T>(CancellationToken cancellationToken = default)
    {
        ThrowIfLiveMode();
        var result = new List<T>();
        await foreach (var item in ReadJsonAsync<T>(cancellationToken).ConfigureAwait(false))
        {
            result.Add(item);
        }
        return result;
    }

    /// <summary>
    /// Accumulate all text until upToDate, then return.
    /// Only valid with LiveMode.Off; throws InvalidOperationException for live modes.
    /// </summary>
    public async Task<string> ReadAllTextAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfLiveMode();
        var sb = new StringBuilder();
        await foreach (var chunk in ReadTextAsync(cancellationToken).ConfigureAwait(false))
        {
            sb.Append(chunk.Text);
        }
        return sb.ToString();
    }

    /// <summary>
    /// Cancel the session.
    /// </summary>
    public void Cancel()
    {
        _cts.Cancel();
    }

    private async Task<ByteChunk?> ReadNextChunkAsync(CancellationToken cancellationToken)
    {
        if (_options.Live == LiveMode.Sse)
        {
            return await ReadNextSseChunkAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            return await ReadNextHttpChunkAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<ByteChunk?> ReadNextHttpChunkAsync(CancellationToken cancellationToken)
    {
        // For long-poll, we may need to make a request now (deferred from previous chunk)
        if (_currentResponse == null && _options.Live == LiveMode.LongPoll)
        {
            await MakeRequestAsync().ConfigureAwait(false);
        }

        if (_currentResponse == null)
        {
            return null;
        }

        var response = _currentResponse;
        _currentResponse = null;

        try
        {
            var statusCode = response.StatusCode;

            if (statusCode == HttpStatusCode.NotFound)
            {
                throw new StreamNotFoundException(_stream.Url);
            }

            if (statusCode == HttpStatusCode.Gone)
            {
                throw new DurableStreamException("Offset no longer available",
                    DurableStreamErrorCode.OffsetGone, 410, _stream.Url);
            }

            if (!response.IsSuccessStatusCode && statusCode != HttpStatusCode.NoContent &&
                statusCode != HttpStatusCode.NotModified)
            {
                throw DurableStreamException.FromStatusCode((int)statusCode, _stream.Url);
            }

            // Update state from headers
            var nextOffset = HttpHelpers.GetHeader(response, Headers.StreamNextOffset);
            var cursor = HttpHelpers.GetHeader(response, Headers.StreamCursor);
            var upToDate = HttpHelpers.GetBoolHeader(response, Headers.StreamUpToDate);

            if (nextOffset != null)
            {
                _offset = new Offset(nextOffset);
            }
            if (cursor != null)
            {
                _cursor = cursor;
            }
            _upToDate = upToDate;

            // Update content type if present
            var contentType = HttpHelpers.GetHeader(response, Headers.ContentType);
            if (contentType != null)
            {
                _stream.ContentType = contentType;
            }

            byte[] data;
            if (statusCode == HttpStatusCode.OK)
            {
                data = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            }
            else
            {
                data = [];
            }

            // Store chunk before making next request (so we can return it immediately)
            var chunk = new ByteChunk(data, new StreamCheckpoint(_offset, _cursor), _upToDate);

            // Prepare for next request if we'll need one
            // For long-poll when upToDate: DON'T pre-fetch (would block 30s for new data)
            // For SSE or when not upToDate: pre-fetch to keep pipeline moving
            var shouldPreFetch = !_upToDate || _options.Live == LiveMode.Sse;

            if (shouldPreFetch || _options.Live == LiveMode.LongPoll)
            {
                UpdateUrlForNextRequest();
                if (shouldPreFetch)
                {
                    await MakeRequestAsync().ConfigureAwait(false);
                }
            }

            return chunk;
        }
        finally
        {
            response.Dispose();
        }
    }

    private async Task<ByteChunk?> ReadNextSseChunkAsync(CancellationToken cancellationToken)
    {
        // Return pending data if we have it with control info
        if (_pendingSseData != null)
        {
            // Wait for control event
        }

        // Ensure we have an SSE connection
        if (_sseParser == null)
        {
            if (_currentResponse == null)
            {
                return null;
            }

            // Check for HTTP errors before trying to parse SSE
            var statusCode = _currentResponse.StatusCode;
            if (statusCode == HttpStatusCode.NotFound)
            {
                throw new StreamNotFoundException(_stream.Url);
            }
            if (statusCode == HttpStatusCode.Gone)
            {
                throw new DurableStreamException("Offset no longer available",
                    DurableStreamErrorCode.OffsetGone, 410, _stream.Url);
            }
            if (!_currentResponse.IsSuccessStatusCode)
            {
                throw DurableStreamException.FromStatusCode((int)statusCode, _stream.Url);
            }

            var stream = await _currentResponse.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            _sseParser = new SseParser(stream);

            // Update content type
            var contentType = HttpHelpers.GetHeader(_currentResponse, Headers.ContentType);
            if (contentType != null && !contentType.StartsWith("text/event-stream", StringComparison.OrdinalIgnoreCase))
            {
                _stream.ContentType = contentType;
            }
        }

        while (!cancellationToken.IsCancellationRequested)
        {
            var evt = await _sseParser.ReadEventAsync(cancellationToken).ConfigureAwait(false);

            if (evt == null)
            {
                // Connection closed - reconnect if in live mode
                CloseSseConnection();

                if (_options.Live == LiveMode.Sse)
                {
                    // Backoff before reconnecting to avoid hot-loop on flaky connections
                    _sseReconnectAttempts++;
                    var baseDelay = Math.Min(100 * (1 << Math.Min(_sseReconnectAttempts - 1, 6)), 5000); // 100ms -> 5s max
                    var jitter = Random.Shared.Next(0, baseDelay / 2);
                    await Task.Delay(baseDelay + jitter, cancellationToken).ConfigureAwait(false);

                    UpdateUrlForNextRequest();
                    await MakeRequestAsync().ConfigureAwait(false);

                    if (_currentResponse == null)
                    {
                        return null;
                    }

                    var stream = await _currentResponse.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                    _sseParser = new SseParser(stream);
                    continue;
                }

                return null;
            }

            var (type, eventObj) = evt.Value;

            if (type == SseEventType.Data)
            {
                var dataEvt = (SseDataEvent)eventObj;
                _pendingSseData = (_pendingSseData ?? "") + dataEvt.Data;
            }
            else if (type == SseEventType.Control)
            {
                var controlEvt = (SseControlEvent)eventObj;

                // Update state
                if (!string.IsNullOrEmpty(controlEvt.StreamNextOffset))
                {
                    _offset = new Offset(controlEvt.StreamNextOffset);
                }
                if (controlEvt.StreamCursor != null)
                {
                    _cursor = controlEvt.StreamCursor;
                }
                _upToDate = controlEvt.UpToDate;

                // Reset reconnect backoff on successful data
                _sseReconnectAttempts = 0;

                // Return pending data with control metadata
                var data = _pendingSseData != null ? Encoding.UTF8.GetBytes(_pendingSseData) : [];
                _pendingSseData = null;

                return new ByteChunk(data, new StreamCheckpoint(_offset, _cursor), _upToDate);
            }
        }

        return null;
    }

    private void UpdateUrlForNextRequest()
    {
        var queryParams = new Dictionary<string, string?>
        {
            [QueryParams.Offset] = _offset.ToString()
        };

        if (_options.Live != LiveMode.Off)
        {
            queryParams[QueryParams.Live] = _options.Live switch
            {
                LiveMode.LongPoll => "long-poll",
                LiveMode.Sse => "sse",
                _ => null
            };
        }

        if (_cursor != null)
        {
            queryParams[QueryParams.Cursor] = _cursor;
        }

        _url = HttpHelpers.BuildUrl(_stream.Url, queryParams);
    }

    private async Task MakeRequestAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, _url);
        await _stream.Client.ApplyDefaultHeadersAsync(request, _cts.Token).ConfigureAwait(false);

        if (_options.Headers != null)
        {
            foreach (var (key, value) in _options.Headers)
            {
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }

        if (_options.Live == LiveMode.Sse)
        {
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        }

        _currentResponse = await _stream.Client.HttpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, _cts.Token)
            .ConfigureAwait(false);
    }

    private void CloseSseConnection()
    {
        _sseParser?.Dispose();
        _sseParser = null;
        _currentResponse?.Dispose();
        _currentResponse = null;
    }

    private void ThrowIfConsumed()
    {
        if (_consumed)
        {
            throw new InvalidOperationException(
                "This response has already been consumed. " +
                "IStreamResponse is single-consumer; create a new StreamAsync() session for multiple reads.");
        }
    }

    private void ThrowIfLiveMode()
    {
        if (_options.Live != LiveMode.Off)
        {
            throw new InvalidOperationException(
                $"ReadAll* methods require LiveMode.Off. Current mode is {_options.Live}. " +
                "Use the streaming Read* methods (ReadBytesAsync, ReadJsonAsync, etc.) for live modes.");
        }
    }

    private List<T> ParseJsonBatch<T>(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty)
            return [];

        var jsonOptions = _stream.Client.Options.JsonSerializerOptions;

        try
        {
            // Try to parse as array
            var items = JsonSerializer.Deserialize<List<T>>(data, jsonOptions);
            return items ?? [];
        }
        catch (JsonException)
        {
            // Try as single item (server may send unwrapped single values)
            try
            {
                var item = JsonSerializer.Deserialize<T>(data, jsonOptions);
                return item != null ? [item] : [];
            }
            catch (JsonException ex)
            {
                // Log and throw - don't silently swallow parse errors
                var preview = data.Length > 100
                    ? Encoding.UTF8.GetString(data[..100]) + "..."
                    : Encoding.UTF8.GetString(data);
                throw new DurableStreamException(
                    $"Failed to parse JSON response: {ex.Message}. Data preview: {preview}",
                    DurableStreamErrorCode.ParseError,
                    null,
                    null);
            }
        }
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync()
    {
        if (_disposed) return ValueTask.CompletedTask;
        _disposed = true;

        _cts.Cancel();
        CloseSseConnection();
        _cts.Dispose();

        return ValueTask.CompletedTask;
    }
}
