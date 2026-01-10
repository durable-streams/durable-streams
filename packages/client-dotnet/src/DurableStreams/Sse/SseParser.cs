using System.Buffers;
using System.Text;
using System.Text.Json;

namespace DurableStreams.Sse;

/// <summary>
/// SSE event types.
/// </summary>
internal enum SseEventType
{
    Data,
    Control
}

/// <summary>
/// Parsed SSE data event.
/// </summary>
internal readonly record struct SseDataEvent(string Data);

/// <summary>
/// Parsed SSE control event.
/// </summary>
internal readonly record struct SseControlEvent(
    string StreamNextOffset,
    string? StreamCursor,
    bool UpToDate);

/// <summary>
/// Parser for Server-Sent Events stream.
/// </summary>
internal sealed class SseParser : IDisposable
{
    private readonly StreamReader _reader;
    private readonly StringBuilder _dataBuffer = new();
    private string? _eventType;
    private bool _disposed;

    public SseParser(Stream stream)
    {
        _reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false);
    }

    /// <summary>
    /// Read the next SSE event.
    /// Returns null on end of stream.
    /// </summary>
    public async Task<(SseEventType Type, object Event)?> ReadEventAsync(CancellationToken cancellationToken = default)
    {
        while (!_disposed)
        {
            var line = await _reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);

            if (line == null)
            {
                // End of stream - try to flush any pending event
                var finalEvent = FlushEvent();
                return finalEvent;
            }

            // Empty line signals end of event
            if (string.IsNullOrEmpty(line))
            {
                var evt = FlushEvent();
                if (evt != null)
                {
                    return evt;
                }
                continue;
            }

            // Parse line
            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                _eventType = line[6..].TrimStart();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                var content = line[5..];
                // Strip optional leading space
                if (content.StartsWith(' '))
                {
                    content = content[1..];
                }

                if (_dataBuffer.Length > 0)
                {
                    _dataBuffer.Append('\n');
                }
                _dataBuffer.Append(content);
            }
            // Ignore id:, retry:, and comment lines (:)
        }

        return null;
    }

    private (SseEventType Type, object Event)? FlushEvent()
    {
        if (_eventType == null || _dataBuffer.Length == 0)
        {
            _eventType = null;
            _dataBuffer.Clear();
            return null;
        }

        var data = _dataBuffer.ToString();
        var eventType = _eventType;

        _eventType = null;
        _dataBuffer.Clear();

        return eventType switch
        {
            "data" => (SseEventType.Data, new SseDataEvent(data)),
            "control" => ParseControlEvent(data),
            _ => null // Unknown event type
        };
    }

    private static (SseEventType Type, object Event)? ParseControlEvent(string data)
    {
        try
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;

            var streamNextOffset = root.TryGetProperty("streamNextOffset", out var offsetProp)
                ? offsetProp.GetString() ?? ""
                : "";

            var streamCursor = root.TryGetProperty("streamCursor", out var cursorProp)
                ? cursorProp.GetString()
                : null;

            var upToDate = root.TryGetProperty("upToDate", out var upToDateProp) &&
                          upToDateProp.ValueKind == JsonValueKind.True;

            return (SseEventType.Control, new SseControlEvent(streamNextOffset, streamCursor, upToDate));
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _reader.Dispose();
    }
}
