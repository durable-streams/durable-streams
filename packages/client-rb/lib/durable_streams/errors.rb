# frozen_string_literal: true

module DurableStreams
  # Base error class for all Durable Streams errors
  class Error < StandardError
    attr_reader :url, :status, :headers, :code

    def initialize(message = nil, url: nil, status: nil, headers: nil, code: nil)
      super(message)
      @url = url
      @status = status
      @headers = headers || {}
      @code = code
    end
  end

  # Stream not found (404)
  class StreamNotFoundError < Error
    def initialize(url: nil, **opts)
      super("Stream not found: #{url}", url: url, status: 404, code: "NOT_FOUND", **opts)
    end
  end

  # Stream already exists with different config (409)
  class StreamExistsError < Error
    def initialize(url: nil, **opts)
      super("Stream already exists: #{url}", url: url, status: 409, code: "CONFLICT_EXISTS", **opts)
    end
  end

  # Sequence conflict (409 with Stream-Seq)
  class SeqConflictError < Error
    def initialize(url: nil, **opts)
      message = url ? "Sequence conflict: #{url}" : "Sequence conflict"
      super(message, url: url, status: 409, code: "CONFLICT_SEQ", **opts)
    end
  end

  # Content type mismatch (409)
  class ContentTypeMismatchError < Error
    def initialize(url: nil, expected: nil, actual: nil, **opts)
      super("Content type mismatch: expected #{expected}, got #{actual}",
            url: url, status: 409, code: "CONFLICT", **opts)
    end
  end

  # Producer epoch is stale (403)
  class StaleEpochError < Error
    attr_reader :current_epoch

    def initialize(message = "Stale producer epoch", current_epoch: nil, **opts)
      super(message, status: 403, code: "FORBIDDEN", **opts)
      @current_epoch = current_epoch
    end
  end

  # Producer sequence gap (409)
  class SequenceGapError < Error
    attr_reader :expected_seq, :received_seq

    def initialize(expected_seq: nil, received_seq: nil, url: nil, **opts)
      message = "Sequence gap: expected #{expected_seq}, got #{received_seq}"
      message = "#{message} (#{url})" if url
      super(message, url: url, status: 409, code: "SEQUENCE_GAP", **opts)
      @expected_seq = expected_seq
      @received_seq = received_seq
    end
  end

  # Rate limited (429)
  class RateLimitedError < Error
    def initialize(url: nil, **opts)
      message = url ? "Rate limited: #{url}" : "Rate limited"
      super(message, url: url, status: 429, code: "RATE_LIMITED", **opts)
    end
  end

  # Bad request (400)
  class BadRequestError < Error
    def initialize(message = "Bad request", url: nil, **opts)
      super(message, url: url, status: 400, code: "BAD_REQUEST", **opts)
    end
  end

  # Network/connection error
  class ConnectionError < Error
    def initialize(message = "Connection error", **opts)
      super(message, code: "NETWORK_ERROR", **opts)
    end
  end

  # Timeout error
  class TimeoutError < Error
    def initialize(message = "Request timeout", **opts)
      super(message, code: "TIMEOUT", **opts)
    end
  end

  # Reader already consumed
  class AlreadyConsumedError < Error
    def initialize(**opts)
      super("Reader already consumed", code: "ALREADY_CONSUMED", **opts)
    end
  end

  # Producer or stream has been closed
  class ClosedError < Error
    def initialize(message = "Producer is closed", **opts)
      super(message, code: "CLOSED", **opts)
    end
  end

  # SSE not supported for this content type
  class SSENotSupportedError < Error
    def initialize(content_type: nil, **opts)
      super("SSE not supported for content type: #{content_type}",
            status: 400, code: "SSE_NOT_SUPPORTED", **opts)
    end
  end

  # Parse error (malformed JSON, SSE, etc.)
  class ParseError < Error
    def initialize(message = "Parse error", **opts)
      super(message, code: "PARSE_ERROR", **opts)
    end
  end

  # Generic fetch error for unexpected statuses
  class FetchError < Error
    def initialize(message = "Fetch error", url: nil, status: nil, **opts)
      super(message, url: url, status: status, code: "UNEXPECTED_STATUS", **opts)
    end
  end

  # Map HTTP status to appropriate error
  def self.error_from_status(status, url: nil, body: nil, headers: nil, operation: nil)
    case status
    when 400
      BadRequestError.new(body || "Bad request", url: url, headers: headers)
    when 403
      StaleEpochError.new(body || "Forbidden", url: url, headers: headers)
    when 404
      StreamNotFoundError.new(url: url, headers: headers)
    when 409
      # Could be StreamExistsError or SeqConflictError depending on context
      if headers&.key?("stream-seq")
        SeqConflictError.new(url: url, headers: headers)
      else
        StreamExistsError.new(url: url, headers: headers)
      end
    when 429
      RateLimitedError.new(url: url, headers: headers)
    else
      FetchError.new(body || "HTTP #{status}", url: url, status: status, headers: headers)
    end
  end
end
