using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DurableStreams.Internal;

namespace DurableStreams;

/// <summary>
/// A handle to a durable stream for read/write operations.
/// Lightweight and reusable - not a persistent connection.
/// </summary>
public sealed class DurableStream
{
    private readonly DurableStreamClient _client;
    private readonly string _url;
    private string? _contentType;

    /// <summary>
    /// Creates a new DurableStream handle.
    /// </summary>
    internal DurableStream(DurableStreamClient client, string url)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _url = url ?? throw new ArgumentNullException(nameof(url));
    }

    /// <summary>
    /// The stream URL.
    /// </summary>
    public string Url => _url;

    /// <summary>
    /// The content type (populated after HEAD/read).
    /// </summary>
    public string? ContentType
    {
        get => _contentType;
        internal set => _contentType = value;
    }

    /// <summary>
    /// Internal access to the client.
    /// </summary>
    internal DurableStreamClient Client => _client;

    /// <summary>
    /// Create a new stream. Returns Created if a new stream was created, or AlreadyExisted if it existed.
    /// </summary>
    public async Task<CreateStreamResult> CreateAsync(
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, _url);
        await _client.ApplyDefaultHeadersAsync(request, cancellationToken).ConfigureAwait(false);

        if (options?.Headers != null)
        {
            foreach (var (key, value) in options.Headers)
            {
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }

        var contentType = options?.ContentType ?? ContentTypes.OctetStream;
        if (options?.Ttl != null)
        {
            var ttlSeconds = (int)options.Ttl.Value.TotalSeconds;
            request.Headers.TryAddWithoutValidation(Headers.StreamTtl, ttlSeconds.ToString());
        }
        if (options?.ExpiresAt != null)
        {
            request.Headers.TryAddWithoutValidation(Headers.StreamExpiresAt, options.ExpiresAt.Value.ToString("o"));
        }

        if (options?.InitialData != null)
        {
            request.Content = new ByteArrayContent(options.InitialData);
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        }
        else
        {
            request.Content = new ByteArrayContent([]);
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        }

        using var response = await SendWithRetryAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode != HttpStatusCode.Created && response.StatusCode != HttpStatusCode.OK)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw response.StatusCode switch
            {
                HttpStatusCode.Conflict => new DurableStreamException(
                    "Stream already exists with different configuration",
                    DurableStreamErrorCode.ConflictExists, 409, _url),
                _ => DurableStreamException.FromStatusCode((int)response.StatusCode, _url, body)
            };
        }

        _contentType = HttpHelpers.GetHeader(response, Headers.ContentType) ?? contentType;
        return response.StatusCode == HttpStatusCode.Created
            ? CreateStreamResult.Created
            : CreateStreamResult.AlreadyExisted;
    }

    /// <summary>
    /// Get stream metadata via HEAD request.
    /// </summary>
    public async Task<StreamMetadata> HeadAsync(CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, _url);
        await _client.ApplyDefaultHeadersAsync(request, cancellationToken).ConfigureAwait(false);

        using var response = await SendWithRetryAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new StreamNotFoundException(_url);
        }

        if (!response.IsSuccessStatusCode)
        {
            throw DurableStreamException.FromStatusCode((int)response.StatusCode, _url);
        }

        var contentType = HttpHelpers.GetHeader(response, Headers.ContentType);
        _contentType = contentType;

        var nextOffsetHeader = HttpHelpers.GetHeader(response, Headers.StreamNextOffset);
        var ttlSeconds = HttpHelpers.GetIntHeader(response, Headers.StreamTtl);
        var expiresAtStr = HttpHelpers.GetHeader(response, Headers.StreamExpiresAt);

        return new StreamMetadata(
            Exists: true,
            ContentType: contentType,
            Offset: nextOffsetHeader != null ? new Offset(nextOffsetHeader) : (Offset?)null,
            ETag: HttpHelpers.GetHeader(response, Headers.ETag),
            CacheControl: HttpHelpers.GetHeader(response, Headers.CacheControl),
            Ttl: ttlSeconds.HasValue ? TimeSpan.FromSeconds(ttlSeconds.Value) : null,
            ExpiresAt: expiresAtStr != null && DateTimeOffset.TryParse(expiresAtStr, out var expiresAt) ? expiresAt : null
        );
    }

    /// <summary>
    /// Append raw bytes to the stream.
    /// </summary>
    public async Task<AppendResult> AppendAsync(
        ReadOnlyMemory<byte> data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        if (data.IsEmpty)
        {
            throw new DurableStreamException("Empty append not allowed", DurableStreamErrorCode.BadRequest, 400, _url);
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, _url);
        await _client.ApplyDefaultHeadersAsync(request, cancellationToken).ConfigureAwait(false);

        if (options?.Headers != null)
        {
            foreach (var (key, value) in options.Headers)
            {
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }

        if (options?.Seq != null)
        {
            request.Headers.TryAddWithoutValidation(Headers.StreamSeq, options.Seq);
        }

        var contentType = _contentType ?? ContentTypes.OctetStream;
        request.Content = new ByteArrayContent(data.ToArray());
        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);

        using var response = await SendWithRetryAsync(request, cancellationToken, retryAppend: false).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw response.StatusCode switch
            {
                HttpStatusCode.NotFound => new StreamNotFoundException(_url),
                HttpStatusCode.Conflict => new DurableStreamException(
                    "Sequence conflict", DurableStreamErrorCode.ConflictSeq, 409, _url),
                _ => DurableStreamException.FromStatusCode((int)response.StatusCode, _url, body)
            };
        }

        var nextOffset = HttpHelpers.GetHeader(response, Headers.StreamNextOffset);
        return new AppendResult(
            NextOffset: nextOffset is { } offsetStr ? new Offset(offsetStr) : (Offset?)null,
            Duplicate: false
        );
    }

    /// <summary>
    /// Append a string to the stream.
    /// </summary>
    public Task<AppendResult> AppendAsync(
        string data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return AppendAsync(Encoding.UTF8.GetBytes(data), options, cancellationToken);
    }

    /// <summary>
    /// Append a JSON object to the stream.
    /// For JSON streams, wraps in array for proper batching (server flattens).
    /// </summary>
    public async Task<AppendResult> AppendJsonAsync<T>(
        T data,
        AppendOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var isJson = HttpHelpers.IsJsonContentType(_contentType);
        var jsonOptions = _client.Options.JsonSerializerOptions;
        byte[] bytes;

        if (isJson)
        {
            // Wrap in array for JSON mode (server flattens one level)
            bytes = JsonSerializer.SerializeToUtf8Bytes(new[] { data }, jsonOptions);
        }
        else
        {
            bytes = JsonSerializer.SerializeToUtf8Bytes(data, jsonOptions);
        }

        return await AppendAsync(bytes, options, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Delete this stream.
    /// </summary>
    public async Task DeleteAsync(CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, _url);
        await _client.ApplyDefaultHeadersAsync(request, cancellationToken).ConfigureAwait(false);

        using var response = await SendWithRetryAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new StreamNotFoundException(_url);
        }

        if (!response.IsSuccessStatusCode)
        {
            throw DurableStreamException.FromStatusCode((int)response.StatusCode, _url);
        }
    }

    /// <summary>
    /// Start a streaming read session.
    /// </summary>
    public async Task<StreamResponse> StreamAsync(
        StreamOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new StreamOptions();

        // Build initial request
        var queryParams = new Dictionary<string, string?>
        {
            [QueryParams.Offset] = options.Offset?.ToString() ?? Offset.Beginning.ToString()
        };

        if (options.Live != LiveMode.Off)
        {
            queryParams[QueryParams.Live] = options.Live switch
            {
                LiveMode.LongPoll => "long-poll",
                LiveMode.Sse => "sse",
                _ => null
            };
        }

        if (options.Cursor != null)
        {
            queryParams[QueryParams.Cursor] = options.Cursor;
        }

        var url = HttpHelpers.BuildUrl(_url, queryParams);

        var response = new StreamResponse(this, options, url, cancellationToken);
        await response.InitializeAsync().ConfigureAwait(false);
        return response;
    }

    /// <summary>
    /// Create an idempotent producer for exactly-once writes.
    /// </summary>
    public IdempotentProducer CreateProducer(
        string producerId,
        IdempotentProducerOptions? options = null)
    {
        return new IdempotentProducer(this, producerId, options ?? new IdempotentProducerOptions());
    }

    /// <summary>
    /// Send request with retry logic.
    /// </summary>
    internal async Task<HttpResponseMessage> SendWithRetryAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken,
        bool retryAppend = true)
    {
        var options = _client.Options;
        var delay = options.InitialRetryDelay;
        var lastResponse = (HttpResponseMessage?)null;

        for (var attempt = 0; attempt <= options.MaxRetries; attempt++)
        {
            // Clone request for retry (original gets disposed after first send)
            HttpRequestMessage? currentRequest;
            if (attempt == 0)
            {
                currentRequest = request;
            }
            else
            {
                currentRequest = await CloneRequestAsync(request).ConfigureAwait(false);
            }

            try
            {
                var response = await _client.HttpClient
                    .SendAsync(currentRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                    .ConfigureAwait(false);

                // For POST without retryAppend flag, only retry on server errors (5xx)
                // Success (2xx) and client errors (4xx) should not be retried as data may have been written
                if (!retryAppend && request.Method == HttpMethod.Post)
                {
                    // Only retry 5xx server errors for non-idempotent appends
                    if ((int)response.StatusCode < 500 || !HttpHelpers.IsRetryableStatus(response.StatusCode) || attempt >= options.MaxRetries)
                    {
                        return response;
                    }
                    // Fall through to retry logic for retryable 5xx errors
                }
                else
                {
                    // Check if retryable for other request types
                    if (!HttpHelpers.IsRetryableStatus(response.StatusCode) || attempt >= options.MaxRetries)
                    {
                        return response;
                    }
                }

                // Calculate retry delay
                var retryAfter = HttpHelpers.ParseRetryAfter(HttpHelpers.GetHeader(response, Headers.RetryAfter));
                var waitTime = retryAfter ?? delay;

                // Add jitter
                var jitter = TimeSpan.FromMilliseconds(Random.Shared.Next(0, (int)delay.TotalMilliseconds));
                waitTime += jitter;

                if (waitTime > options.MaxRetryDelay)
                    waitTime = options.MaxRetryDelay;

                lastResponse?.Dispose();
                lastResponse = response;

                await Task.Delay(waitTime, cancellationToken).ConfigureAwait(false);
                delay = TimeSpan.FromMilliseconds(delay.TotalMilliseconds * options.RetryMultiplier);
            }
            catch (HttpRequestException) when (attempt < options.MaxRetries)
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                delay = TimeSpan.FromMilliseconds(delay.TotalMilliseconds * options.RetryMultiplier);
            }
            finally
            {
                if (attempt > 0)
                {
                    currentRequest?.Dispose();
                }
            }
        }

        return lastResponse ?? throw new DurableStreamException(
            "Max retries exceeded", DurableStreamErrorCode.NetworkError, null, _url);
    }

    private static async Task<HttpRequestMessage> CloneRequestAsync(HttpRequestMessage original)
    {
        var clone = new HttpRequestMessage(original.Method, original.RequestUri);

        foreach (var header in original.Headers)
        {
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        if (original.Content != null)
        {
            var content = await original.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            clone.Content = new ByteArrayContent(content);

            foreach (var header in original.Content.Headers)
            {
                clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }

        return clone;
    }
}
