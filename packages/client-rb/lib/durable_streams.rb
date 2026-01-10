# frozen_string_literal: true

require_relative "durable_streams/version"
require_relative "durable_streams/errors"
require_relative "durable_streams/types"
require_relative "durable_streams/http/transport"
require_relative "durable_streams/client"
require_relative "durable_streams/stream"
require_relative "durable_streams/json_reader"
require_relative "durable_streams/byte_reader"
require_relative "durable_streams/sse_reader"
require_relative "durable_streams/idempotent_producer"

module DurableStreams
  class << self
    attr_accessor :logger

    # Create a new stream on the server
    # @param url [String] Stream URL
    # @param content_type [String] Content type for the stream
    # @param ttl_seconds [Integer, nil] Time-to-live in seconds
    # @param expires_at [String, nil] Absolute expiry time (RFC3339)
    # @param body [String, nil] Optional initial body
    # @param headers [Hash] HTTP headers
    # @return [Stream]
    def create(url:, content_type: nil, ttl_seconds: nil, expires_at: nil, body: nil, headers: {})
      Stream.create(url: url, content_type: content_type, ttl_seconds: ttl_seconds,
                    expires_at: expires_at, body: body, headers: headers)
    end

    # Connect to an existing stream
    # @param url [String] Stream URL
    # @param headers [Hash] HTTP headers
    # @return [Stream]
    def connect(url:, headers: {})
      Stream.connect(url: url, headers: headers)
    end

    # One-shot append to a stream
    # @param url [String] Stream URL
    # @param data [Object] Data to append
    # @param headers [Hash] HTTP headers
    # @return [AppendResult]
    def append(url:, data:, headers: {})
      stream = Stream.new(url: url, headers: headers)
      stream.append(data)
    end

    # One-shot read from a stream
    # @param url [String] Stream URL
    # @param offset [String] Starting offset
    # @param headers [Hash] HTTP headers
    # @return [Array] Messages
    def read(url:, offset: "-1", headers: {})
      stream = Stream.new(url: url, headers: headers)
      stream.read_all(offset: offset)
    end
  end

  # Default logger
  self.logger = nil
end
