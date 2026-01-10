namespace DurableStreams.Internal;

/// <summary>
/// Protocol header constants.
/// </summary>
internal static class Headers
{
    public const string ContentType = "Content-Type";
    public const string StreamNextOffset = "Stream-Next-Offset";
    public const string StreamCursor = "Stream-Cursor";
    public const string StreamUpToDate = "Stream-Up-To-Date";
    public const string StreamSeq = "Stream-Seq";
    public const string StreamTtl = "Stream-TTL";
    public const string StreamExpiresAt = "Stream-Expires-At";
    public const string ETag = "ETag";
    public const string IfMatch = "If-Match";
    public const string CacheControl = "Cache-Control";
    public const string RetryAfter = "Retry-After";

    // Idempotent producer headers
    public const string ProducerId = "Producer-Id";
    public const string ProducerEpoch = "Producer-Epoch";
    public const string ProducerSeq = "Producer-Seq";
    public const string ProducerExpectedSeq = "Producer-Expected-Seq";
    public const string ProducerReceivedSeq = "Producer-Received-Seq";
}

/// <summary>
/// Common content types.
/// </summary>
internal static class ContentTypes
{
    public const string Json = "application/json";
    public const string OctetStream = "application/octet-stream";
    public const string TextPlain = "text/plain";
    public const string EventStream = "text/event-stream";
}

/// <summary>
/// Query parameter constants.
/// </summary>
internal static class QueryParams
{
    public const string Offset = "offset";
    public const string Live = "live";
    public const string Cursor = "cursor";
}
