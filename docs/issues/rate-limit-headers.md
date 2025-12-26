# Rate Limit Headers (X-RateLimit-*)

## Summary

Specify the `X-RateLimit-*` family of headers for servers to communicate rate limit status, and require clients to parse them in conformance tests.

## Problem

The protocol specifies `429 Too Many Requests` and `Retry-After` for rate limiting, but doesn't provide proactive rate limit information. Clients can't:

- Know their current quota remaining
- Proactively throttle before hitting limits
- Display rate limit status to users
- Implement smarter backoff strategies

## Proposal

Servers MAY include rate limit headers on any response. Clients MUST be able to parse these headers when present.

### Headers

| Header | Type | Description |
|--------|------|-------------|
| `X-RateLimit-Limit` | integer | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | integer | Requests remaining in current window |
| `X-RateLimit-Reset` | integer | Unix timestamp when the window resets |

### Example Response

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 742
X-RateLimit-Reset: 1735200000
```

### On 429 Response

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 30
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1735200000

{
  "type": "/errors/rate-limited",
  "title": "Rate Limited",
  "status": 429,
  "code": "RATE_LIMITED",
  "detail": "Rate limit exceeded. Try again in 30 seconds."
}
```

### Scope

Rate limits MAY be scoped by:
- Per-client (API key, IP address)
- Per-stream
- Global

The headers represent the most restrictive applicable limit. Servers MAY include additional headers to indicate scope:

```http
X-RateLimit-Scope: client
```

## Protocol Changes

Add to PROTOCOL.md Section 10.5 (Rate Limiting):

```markdown
### 10.5. Rate Limiting

Servers SHOULD implement rate limiting to prevent abuse. The `429 Too Many
Requests` response code indicates rate limit exhaustion.

**Response Headers (on any response):**

Servers MAY include rate limit information headers:

- `X-RateLimit-Limit: <integer>`
  - Maximum requests allowed in the current window

- `X-RateLimit-Remaining: <integer>`
  - Requests remaining before rate limit is reached

- `X-RateLimit-Reset: <unix-timestamp>`
  - Unix timestamp (seconds) when the rate limit window resets

- `Retry-After: <seconds>` (on 429 responses)
  - Seconds to wait before retrying
  - Servers MUST include this header on 429 responses

**Client Behavior:**

Clients SHOULD:
- Parse rate limit headers when present
- Proactively throttle when `X-RateLimit-Remaining` is low
- Respect `Retry-After` on 429 responses
- Implement exponential backoff for repeated 429 responses
```

## Conformance Tests

### Server Conformance

```yaml
- id: rate-limit-429-includes-retry-after
  description: 429 response includes Retry-After header
  operations:
    # Server must be configured to rate limit for this test
    - action: trigger-rate-limit  # Test harness helper
    - action: append
      path: ${streamPath}
      expect:
        status: 429
        headers:
          retry-after: present
        errorCode: RATE_LIMITED

- id: rate-limit-headers-format
  description: Rate limit headers are valid integers
  operations:
    - action: read
      path: ${streamPath}
    # If headers present, validate format
    - validate:
        headers:
          x-ratelimit-limit: integer
          x-ratelimit-remaining: integer
          x-ratelimit-reset: unix-timestamp
```

### Client Conformance

Clients MUST parse rate limit headers and expose them:

```yaml
- id: client-parses-rate-limit-headers
  description: Client exposes rate limit headers from response
  operations:
    - action: read
      path: ${streamPath}
      expect:
        # Client adapter must return these in result
        rateLimits:
          limit: integer-or-null
          remaining: integer-or-null
          reset: integer-or-null

- id: client-handles-429-with-retry-after
  description: Client respects Retry-After on 429
  setup:
    inject-error:
      status: 429
      retryAfter: 2
  operations:
    - action: append
      path: ${streamPath}
      expect:
        errorCode: RATE_LIMITED
        retryAfter: 2
```

## Client API

Clients SHOULD expose rate limit information:

```typescript
interface RateLimitInfo {
  /** Max requests in window, or undefined if not provided */
  limit?: number
  /** Remaining requests, or undefined if not provided */
  remaining?: number
  /** Unix timestamp when window resets, or undefined if not provided */
  reset?: number
}

// Available on response/error objects
const result = await stream.append(data)
console.log(result.rateLimit?.remaining)  // 742

// Or on errors
catch (error) {
  if (error.code === 'RATE_LIMITED') {
    console.log(`Retry after ${error.retryAfter} seconds`)
    console.log(`Limit resets at ${error.rateLimit?.reset}`)
  }
}
```

## Implementation Notes

- Rate limit enforcement is implementation-specific (token bucket, sliding window, etc.)
- Headers are informational - clients should handle them gracefully if absent
- `X-RateLimit-Reset` uses Unix timestamps for timezone independence
- Consider including `X-RateLimit-Scope` for multi-tenant clarity

## References

- [IETF Draft: RateLimit Header Fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [GitHub API Rate Limiting](https://docs.github.com/en/rest/rate-limit)
- [Stripe API Rate Limiting](https://stripe.com/docs/rate-limits)
