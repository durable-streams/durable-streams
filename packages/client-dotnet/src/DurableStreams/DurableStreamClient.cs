using System.Net.Http.Headers;
using DurableStreams.Internal;

namespace DurableStreams;

/// <summary>
/// Client for interacting with Durable Streams servers.
/// Thread-safe, designed for singleton use.
/// </summary>
public sealed class DurableStreamClient : IAsyncDisposable, IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly DurableStreamClientOptions _options;
    private readonly bool _ownsHttpClient;
    private bool _disposed;

    /// <summary>
    /// Creates a new DurableStreamClient with default options.
    /// The client will create and own its own HttpClient instance, which will be disposed when the client is disposed.
    /// </summary>
    public DurableStreamClient()
        : this(new DurableStreamClientOptions())
    {
    }

    /// <summary>
    /// Creates a new DurableStreamClient with the specified options.
    /// The client will create and own its own HttpClient instance, which will be disposed when the client is disposed.
    /// </summary>
    /// <param name="options">Configuration options for the client.</param>
    public DurableStreamClient(DurableStreamClientOptions options)
        : this(options, CreateHttpClient(options), ownsHttpClient: true)
    {
    }

    /// <summary>
    /// Creates a new DurableStreamClient with an existing HttpClient.
    /// The client will NOT dispose the provided HttpClient - the caller retains ownership and is responsible for its lifecycle.
    /// Use this constructor when sharing an HttpClient across multiple services or when using IHttpClientFactory.
    /// </summary>
    /// <param name="options">Configuration options for the client.</param>
    /// <param name="httpClient">An existing HttpClient instance. The client will not dispose this instance.</param>
    public DurableStreamClient(DurableStreamClientOptions options, HttpClient httpClient)
        : this(options, httpClient, ownsHttpClient: false)
    {
    }

    private DurableStreamClient(DurableStreamClientOptions options, HttpClient httpClient, bool ownsHttpClient)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _ownsHttpClient = ownsHttpClient;
    }

    private static HttpClient CreateHttpClient(DurableStreamClientOptions options)
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(15),
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            MaxConnectionsPerServer = 100,
            EnableMultipleHttp2Connections = true,
            AutomaticDecompression = System.Net.DecompressionMethods.All
        };

        var client = new HttpClient(handler);

        if (options.BaseUrl != null)
        {
            client.BaseAddress = new Uri(options.BaseUrl);
        }

        if (options.Timeout != null)
        {
            client.Timeout = options.Timeout.Value;
        }

        return client;
    }

    /// <summary>
    /// Internal access to HttpClient for streams.
    /// </summary>
    internal HttpClient HttpClient => _httpClient;

    /// <summary>
    /// Internal access to options.
    /// </summary>
    internal DurableStreamClientOptions Options => _options;

    /// <summary>
    /// Create a cold handle to a stream (no network I/O).
    /// </summary>
    /// <param name="url">The stream URL (absolute or relative to BaseUrl).</param>
    public DurableStream GetStream(string url)
    {
        return new DurableStream(this, ResolveUrl(url));
    }

    /// <summary>
    /// Create a cold handle to a stream (no network I/O).
    /// </summary>
    /// <param name="uri">The stream URI.</param>
    public DurableStream GetStream(Uri uri)
    {
        return GetStream(uri.ToString());
    }

    /// <summary>
    /// Create a new stream and return a handle.
    /// </summary>
    /// <param name="url">The stream URL (absolute or relative to BaseUrl).</param>
    /// <param name="options">Optional stream creation options.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<DurableStream> CreateStreamAsync(
        string url,
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var stream = GetStream(url);
        await stream.CreateAsync(options, cancellationToken).ConfigureAwait(false);
        return stream;
    }

    /// <summary>
    /// Create a new stream and return a handle.
    /// </summary>
    /// <param name="uri">The stream URI.</param>
    /// <param name="options">Optional stream creation options.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public Task<DurableStream> CreateStreamAsync(
        Uri uri,
        CreateStreamOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return CreateStreamAsync(uri.ToString(), options, cancellationToken);
    }

    /// <summary>
    /// Validate that a stream exists via HEAD and return a handle.
    /// </summary>
    /// <param name="url">The stream URL (absolute or relative to BaseUrl).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<DurableStream> ConnectAsync(
        string url,
        CancellationToken cancellationToken = default)
    {
        var stream = GetStream(url);
        await stream.HeadAsync(cancellationToken).ConfigureAwait(false);
        return stream;
    }

    /// <summary>
    /// Validate that a stream exists via HEAD and return a handle.
    /// </summary>
    /// <param name="uri">The stream URI.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public Task<DurableStream> ConnectAsync(
        Uri uri,
        CancellationToken cancellationToken = default)
    {
        return ConnectAsync(uri.ToString(), cancellationToken);
    }

    /// <summary>
    /// Delete a stream.
    /// </summary>
    /// <param name="url">The stream URL (absolute or relative to BaseUrl).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task DeleteStreamAsync(
        string url,
        CancellationToken cancellationToken = default)
    {
        var stream = GetStream(url);
        await stream.DeleteAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Delete a stream.
    /// </summary>
    /// <param name="uri">The stream URI.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public Task DeleteStreamAsync(
        Uri uri,
        CancellationToken cancellationToken = default)
    {
        return DeleteStreamAsync(uri.ToString(), cancellationToken);
    }

    /// <summary>
    /// Resolve a relative URL against the base URL.
    /// </summary>
    internal string ResolveUrl(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out _))
            return url;

        if (_options.BaseUrl == null)
            return url;

        return new Uri(new Uri(_options.BaseUrl), url).ToString();
    }

    /// <summary>
    /// Build headers for a request, including both static and dynamic headers.
    /// Dynamic headers are evaluated once per operation (not re-evaluated on retries).
    /// </summary>
    internal async ValueTask ApplyDefaultHeadersAsync(HttpRequestMessage request, CancellationToken cancellationToken = default)
    {
        if (_options.DefaultHeaders != null)
        {
            foreach (var (key, value) in _options.DefaultHeaders)
            {
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }

        if (_options.DynamicHeaders != null)
        {
            foreach (var (key, factory) in _options.DynamicHeaders)
            {
                var value = await factory(cancellationToken).ConfigureAwait(false);
                request.Headers.TryAddWithoutValidation(key, value);
            }
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }
}
