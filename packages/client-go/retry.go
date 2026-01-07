package durablestreams

import (
	"context"
	"math/rand"
	"net/http"
	"strconv"
	"time"
)

// shouldRetry returns true if the given status code should be retried.
func shouldRetry(statusCode int) bool {
	// Retry on server errors (5xx) and rate limiting (429)
	// Do NOT retry on client errors (4xx except 429)
	if statusCode == http.StatusTooManyRequests {
		return true
	}
	if statusCode >= 500 && statusCode < 600 {
		return true
	}
	return false
}

// parseRetryAfter parses the Retry-After header and returns the delay in milliseconds.
// Returns 0 if the header is not present or invalid.
func parseRetryAfter(header string) time.Duration {
	if header == "" {
		return 0
	}

	// Try parsing as seconds
	if secs, err := strconv.Atoi(header); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}

	// Try parsing as HTTP-date
	if t, err := http.ParseTime(header); err == nil {
		delta := time.Until(t)
		if delta > 0 {
			// Cap at 1 hour
			if delta > time.Hour {
				delta = time.Hour
			}
			return delta
		}
	}

	return 0
}

// doWithRetry executes a request with retry logic.
// The makeRequest function should create a new request on each call (for body re-reading).
func (s *Stream) doWithRetry(
	ctx context.Context,
	makeRequest func() (*http.Request, error),
) (*http.Response, error) {
	policy := s.client.retryPolicy
	delay := policy.InitialDelay

	for attempt := 0; attempt <= policy.MaxRetries; attempt++ {
		// Create a fresh request for each attempt
		req, err := makeRequest()
		if err != nil {
			return nil, err
		}

		// Execute request
		resp, err := s.client.httpClient.Do(req)
		if err != nil {
			// Network error - check context
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Retry network errors
			if attempt < policy.MaxRetries {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(delay):
					delay = time.Duration(float64(delay) * policy.Multiplier)
					if delay > policy.MaxDelay {
						delay = policy.MaxDelay
					}
					continue
				}
			}
			return nil, err
		}

		// Check if we should retry based on status code
		if shouldRetry(resp.StatusCode) && attempt < policy.MaxRetries {
			// Check for Retry-After header
			retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))

			// Calculate backoff with jitter
			jitter := time.Duration(rand.Float64() * float64(delay))
			waitTime := jitter
			if retryAfter > waitTime {
				waitTime = retryAfter
			}

			// Discard body before retry
			resp.Body.Close()

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(waitTime):
				delay = time.Duration(float64(delay) * policy.Multiplier)
				if delay > policy.MaxDelay {
					delay = policy.MaxDelay
				}
				continue
			}
		}

		return resp, nil
	}

	// This shouldn't be reached, but return an error just in case
	return nil, newStreamError("request", s.url, 0, ErrRateLimited)
}
