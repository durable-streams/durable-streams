# frozen_string_literal: true

module DurableStreams
  # HTTP header names
  STREAM_NEXT_OFFSET_HEADER = "stream-next-offset"
  STREAM_UP_TO_DATE_HEADER = "stream-up-to-date"
  STREAM_CURSOR_HEADER = "stream-cursor"
  STREAM_TTL_HEADER = "stream-ttl"
  STREAM_EXPIRES_AT_HEADER = "stream-expires-at"
  STREAM_SEQ_HEADER = "stream-seq"
  PRODUCER_ID_HEADER = "producer-id"
  PRODUCER_EPOCH_HEADER = "producer-epoch"
  PRODUCER_SEQ_HEADER = "producer-seq"
  PRODUCER_EXPECTED_SEQ_HEADER = "producer-expected-seq"
  PRODUCER_RECEIVED_SEQ_HEADER = "producer-received-seq"

  # Result from HEAD request
  # next_offset: The tail offset (position after last byte, where next append goes)
  HeadResult = Struct.new(:exists, :content_type, :next_offset, :etag, :cache_control, keyword_init: true) do
    def initialize(**)
      super
      freeze
    end

    def exists?
      exists
    end
  end

  # Result from append
  # next_offset: The new tail offset after this append (for checkpointing)
  AppendResult = Struct.new(:next_offset, :duplicate, keyword_init: true) do
    def initialize(**)
      super
      freeze
    end

    def duplicate?
      duplicate || false
    end
  end

  # A batch of JSON messages with metadata
  # next_offset: Position to resume from (pass to next read)
  JsonBatch = Struct.new(:items, :next_offset, :cursor, :up_to_date, keyword_init: true) do
    def initialize(items: [], **)
      super(items: Array(items).freeze, **)
      freeze
    end

    def up_to_date?
      up_to_date || false
    end
  end

  # A byte chunk (for non-JSON streams)
  # next_offset: Position to resume from (pass to next read)
  ByteChunk = Struct.new(:data, :next_offset, :cursor, :up_to_date, keyword_init: true) do
    def initialize(**)
      super
      freeze
    end

    def up_to_date?
      up_to_date || false
    end
  end

  # Retry policy configuration (not frozen - may be modified before use)
  RetryPolicy = Struct.new(:max_retries, :initial_delay, :max_delay, :multiplier, :retryable_statuses,
                           keyword_init: true) do
    def self.default
      new(
        max_retries: 5,
        initial_delay: 0.1,
        max_delay: 30.0,
        multiplier: 2.0,
        retryable_statuses: [429, 500, 502, 503, 504].freeze
      ).freeze
    end
  end

  # Producer append result (includes epoch/seq for exactly-once tracking)
  ProducerResult = Struct.new(:next_offset, :duplicate, :epoch, :seq, keyword_init: true) do
    def initialize(**)
      super
      freeze
    end

    def duplicate?
      duplicate || false
    end
  end

  # Check if content type is JSON (supports vendor types like application/vnd.foo+json)
  def self.json_content_type?(content_type)
    return false if content_type.nil?

    normalized = content_type.split(";").first&.strip&.downcase
    normalized == "application/json" || normalized&.end_with?("+json")
  end

  # Check if content type supports SSE
  def self.sse_compatible?(content_type)
    return false if content_type.nil?

    normalized = content_type.split(";").first&.strip&.downcase
    normalized == "application/json" || normalized&.start_with?("text/")
  end

  # Normalize offset to a valid string (defaults to "-1" for empty/nil)
  def self.normalize_offset(offset)
    offset.nil? || offset.to_s.empty? ? "-1" : offset.to_s
  end

  # Parse common response headers for stream metadata
  # @param response [HTTP::Response] HTTP response
  # @param defaults [Hash] Default values for missing headers
  # @return [Hash] Parsed header values
  def self.parse_stream_headers(response, defaults = {})
    {
      next_offset: response[STREAM_NEXT_OFFSET_HEADER] || defaults[:next_offset],
      cursor: response[STREAM_CURSOR_HEADER] || defaults[:cursor],
      up_to_date: response[STREAM_UP_TO_DATE_HEADER] == "true"
    }
  end
end
