namespace DurableStreams;

/// <summary>
/// Live streaming mode for read operations.
/// </summary>
public enum LiveMode
{
    /// <summary>
    /// Catch-up only, stop at first upToDate.
    /// </summary>
    Off = 0,

    /// <summary>
    /// Long-poll mode - waits for new data with timeout.
    /// </summary>
    LongPoll = 1,

    /// <summary>
    /// Server-Sent Events mode - persistent streaming connection.
    /// </summary>
    Sse = 2
}
