using System.Net;
using System.Text;

namespace DurableStreams.Internal;

/// <summary>
/// HTTP helper utilities.
/// </summary>
internal static class HttpHelpers
{
    /// <summary>
    /// Normalize content type by extracting media type before semicolon.
    /// </summary>
    public static string NormalizeContentType(string? contentType)
    {
        if (string.IsNullOrEmpty(contentType))
            return string.Empty;

        var semicolonIndex = contentType.IndexOf(';');
        if (semicolonIndex >= 0)
            contentType = contentType[..semicolonIndex];

        return contentType.Trim().ToLowerInvariant();
    }

    /// <summary>
    /// Check if content type is JSON.
    /// </summary>
    public static bool IsJsonContentType(string? contentType)
    {
        return NormalizeContentType(contentType) == ContentTypes.Json;
    }

    /// <summary>
    /// Check if content type is SSE-compatible.
    /// </summary>
    public static bool IsSseCompatible(string? contentType)
    {
        var normalized = NormalizeContentType(contentType);
        return normalized.StartsWith("text/", StringComparison.Ordinal) ||
               normalized == ContentTypes.Json;
    }

    /// <summary>
    /// Build a URL with query parameters.
    /// </summary>
    public static string BuildUrl(string baseUrl, Dictionary<string, string?>? queryParams)
    {
        if (queryParams == null || queryParams.Count == 0)
            return baseUrl;

        var sb = new StringBuilder(baseUrl);
        var separator = baseUrl.Contains('?') ? '&' : '?';

        foreach (var (key, value) in queryParams.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (value != null)
            {
                sb.Append(separator);
                sb.Append(Uri.EscapeDataString(key));
                sb.Append('=');
                sb.Append(Uri.EscapeDataString(value));
                separator = '&';
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Check if a status code indicates a retryable error.
    /// </summary>
    public static bool IsRetryableStatus(HttpStatusCode status)
    {
        var code = (int)status;
        return code == 429 || (code >= 500 && code < 600);
    }

    /// <summary>
    /// Parse Retry-After header value.
    /// </summary>
    public static TimeSpan? ParseRetryAfter(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return null;

        // Try as seconds
        if (int.TryParse(value, out var seconds))
            return TimeSpan.FromSeconds(seconds);

        // Try as HTTP date
        if (DateTimeOffset.TryParse(value, out var date))
        {
            var delay = date - DateTimeOffset.UtcNow;
            return delay > TimeSpan.Zero ? delay : TimeSpan.Zero;
        }

        return null;
    }

    /// <summary>
    /// Get header value or null.
    /// </summary>
    public static string? GetHeader(HttpResponseMessage response, string name)
    {
        if (response.Headers.TryGetValues(name, out var values))
            return values.FirstOrDefault();
        if (response.Content.Headers.TryGetValues(name, out values))
            return values.FirstOrDefault();
        return null;
    }

    /// <summary>
    /// Get integer header value or null.
    /// </summary>
    public static int? GetIntHeader(HttpResponseMessage response, string name)
    {
        var value = GetHeader(response, name);
        return int.TryParse(value, out var result) ? result : null;
    }

    /// <summary>
    /// Get boolean header value (checks for "true").
    /// </summary>
    public static bool GetBoolHeader(HttpResponseMessage response, string name)
    {
        var value = GetHeader(response, name);
        return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }
}
