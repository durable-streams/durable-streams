namespace DurableStreams;

/// <summary>
/// Error codes for Durable Streams operations.
/// </summary>
public enum DurableStreamErrorCode
{
    /// <summary>Unknown error.</summary>
    Unknown,

    /// <summary>Stream not found (404).</summary>
    NotFound,

    /// <summary>Sequence number conflict (409).</summary>
    ConflictSeq,

    /// <summary>Stream already exists with different config (409).</summary>
    ConflictExists,

    /// <summary>Invalid request (400).</summary>
    BadRequest,

    /// <summary>Authentication required (401).</summary>
    Unauthorized,

    /// <summary>Access denied / stale epoch (403).</summary>
    Forbidden,

    /// <summary>Rate limited (429).</summary>
    RateLimited,

    /// <summary>SSE not supported for content type.</summary>
    SseNotSupported,

    /// <summary>Stream/response already closed.</summary>
    AlreadyClosed,

    /// <summary>Offset no longer available (410).</summary>
    OffsetGone,

    /// <summary>Network error.</summary>
    NetworkError,

    /// <summary>Operation timed out.</summary>
    Timeout,

    /// <summary>Failed to parse response (JSON or SSE).</summary>
    ParseError
}

/// <summary>
/// Base exception for all Durable Streams errors.
/// </summary>
public class DurableStreamException : Exception
{
    /// <summary>
    /// The error code.
    /// </summary>
    public DurableStreamErrorCode Code { get; }

    /// <summary>
    /// HTTP status code, if applicable.
    /// </summary>
    public int? StatusCode { get; }

    /// <summary>
    /// Stream URL, if applicable.
    /// </summary>
    public string? StreamUrl { get; }

    /// <summary>
    /// Creates a new DurableStreamException.
    /// </summary>
    public DurableStreamException(
        string message,
        DurableStreamErrorCode code,
        int? statusCode = null,
        string? streamUrl = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
        StatusCode = statusCode;
        StreamUrl = streamUrl;
    }

    /// <summary>
    /// Create exception from HTTP status code.
    /// </summary>
    public static DurableStreamException FromStatusCode(int statusCode, string url, string? message = null)
    {
        var (code, defaultMessage) = statusCode switch
        {
            400 => (DurableStreamErrorCode.BadRequest, "Bad request"),
            401 => (DurableStreamErrorCode.Unauthorized, "Unauthorized"),
            403 => (DurableStreamErrorCode.Forbidden, "Forbidden"),
            404 => (DurableStreamErrorCode.NotFound, "Stream not found"),
            409 => (DurableStreamErrorCode.ConflictExists, "Conflict"),
            410 => (DurableStreamErrorCode.OffsetGone, "Offset no longer available"),
            429 => (DurableStreamErrorCode.RateLimited, "Rate limited"),
            _ when statusCode >= 500 => (DurableStreamErrorCode.Unknown, $"Server error: {statusCode}"),
            _ => (DurableStreamErrorCode.Unknown, $"Unexpected status: {statusCode}")
        };

        return new DurableStreamException(message ?? defaultMessage, code, statusCode, url);
    }
}

/// <summary>
/// Thrown when a stream is not found.
/// </summary>
public class StreamNotFoundException : DurableStreamException
{
    /// <summary>
    /// Creates a new StreamNotFoundException.
    /// </summary>
    public StreamNotFoundException(string url)
        : base($"Stream not found: {url}", DurableStreamErrorCode.NotFound, 404, url)
    {
    }
}

/// <summary>
/// Thrown when a producer's epoch is stale (zombie fencing).
/// </summary>
public class StaleEpochException : DurableStreamException
{
    /// <summary>
    /// The current server epoch.
    /// </summary>
    public int CurrentEpoch { get; }

    /// <summary>
    /// Creates a new StaleEpochException.
    /// </summary>
    public StaleEpochException(int currentEpoch, string? url = null)
        : base(
            $"Producer epoch is stale. Current server epoch: {currentEpoch}. " +
            "Call RestartAsync() or create a new producer with a higher epoch.",
            DurableStreamErrorCode.Forbidden,
            403,
            url)
    {
        CurrentEpoch = currentEpoch;
    }
}

/// <summary>
/// Thrown when an unrecoverable sequence gap is detected.
/// </summary>
public class SequenceGapException : DurableStreamException
{
    /// <summary>
    /// The expected sequence number.
    /// </summary>
    public int ExpectedSeq { get; }

    /// <summary>
    /// The received sequence number.
    /// </summary>
    public int ReceivedSeq { get; }

    /// <summary>
    /// Creates a new SequenceGapException.
    /// </summary>
    public SequenceGapException(int expectedSeq, int receivedSeq, string? url = null)
        : base(
            $"Producer sequence gap: expected {expectedSeq}, received {receivedSeq}",
            DurableStreamErrorCode.ConflictSeq,
            409,
            url)
    {
        ExpectedSeq = expectedSeq;
        ReceivedSeq = receivedSeq;
    }
}
