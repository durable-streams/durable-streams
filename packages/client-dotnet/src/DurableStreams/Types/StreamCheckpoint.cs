namespace DurableStreams;

/// <summary>
/// A checkpoint for resuming stream consumption.
/// Combines offset (position) with cursor (CDN collapsing optimization).
/// Persist this to enable resumption after disconnection or restart.
/// </summary>
public readonly record struct StreamCheckpoint(
    Offset Offset,
    string? Cursor = null)
{
    /// <summary>
    /// Create a checkpoint from just an offset (no cursor).
    /// </summary>
    public static implicit operator StreamCheckpoint(Offset offset) => new(offset);

    /// <summary>
    /// Create a checkpoint from just a string offset (no cursor).
    /// Use for server-provided offset values.
    /// </summary>
    public static explicit operator StreamCheckpoint(string offset) => new(new Offset(offset));
}
