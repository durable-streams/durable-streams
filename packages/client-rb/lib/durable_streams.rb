# frozen_string_literal: true

require "logger"
require_relative "durable_streams/version"
require_relative "durable_streams/errors"
require_relative "durable_streams/types"
require_relative "durable_streams/http/transport"
require_relative "durable_streams/configuration"
require_relative "durable_streams/context"
require_relative "durable_streams/client"
require_relative "durable_streams/stream"
require_relative "durable_streams/json_reader"
require_relative "durable_streams/byte_reader"
require_relative "durable_streams/sse_reader"
require_relative "durable_streams/producer"

module DurableStreams
  class << self
    attr_accessor :logger

    # Get the global configuration
    # @return [Configuration]
    def configuration
      @configuration ||= Configuration.new
    end

    # Configure DurableStreams with a block.
    # The configuration is deep-frozen after the block completes.
    #
    # @example
    #   DurableStreams.configure do |config|
    #     config.base_url = ENV["DURABLE_STREAMS_URL"]
    #     config.default_content_type = :json
    #     config.default_headers = { "Authorization" => -> { "Bearer #{token}" } }
    #   end
    #
    # @yield [Configuration] The configuration object to modify
    def configure
      new_config = configuration.dup
      yield(new_config)
      @configuration = deep_freeze(new_config)
      @default_context = nil # Reset cached context on config change
    end

    # Reset configuration to defaults (mainly for testing)
    def reset_configuration!
      @configuration = Configuration.new
      @default_context = nil
    end

    # Create a new context with optional customizations.
    # Use for isolated configurations (e.g., staging vs production).
    #
    # @example
    #   staging = DurableStreams.new_context do |config|
    #     config.base_url = "https://staging.example.com"
    #   end
    #
    # @yield [Configuration] Optional block to customize the context
    # @return [Context]
    def new_context(&block)
      Context.new(configuration, &block)
    end

    # Get the default context (uses global configuration)
    # @return [Context]
    def default_context
      @default_context ||= new_context
    end

    # Get a Stream handle for the given URL
    # @param url [String] Full URL or path (if base_url configured)
    # @param context [Context] Optional context (defaults to global)
    # @return [Stream]
    def stream(url, context: default_context)
      Stream.new(url, context: context)
    end

    # Create a new stream on the server
    # @param url [String] Stream URL or path
    # @param content_type [Symbol, String] Content type (:json, :bytes, or MIME type)
    # @param context [Context] Optional context
    # @return [Stream]
    def create(url, content_type:, context: default_context, **options)
      Stream.create(url, content_type: content_type, context: context, **options)
    end

    # One-shot append to a stream
    # @param url [String] Stream URL or path
    # @param data [Object] Data to append
    # @param context [Context] Optional context
    # @return [AppendResult]
    def append(url, data, context: default_context, **options)
      stream(url, context: context).append(data, **options)
    end

    # Read from a stream
    # @param url [String] Stream URL or path
    # @param offset [String] Starting offset (default: "-1" for beginning)
    # @param live [Boolean, Symbol] Live mode (false, :auto, :long_poll, :sse)
    # @param format [Symbol] Format hint (:auto, :json, :bytes)
    # @param context [Context] Optional context
    # @return [JsonReader, ByteReader] Reader for iterating messages
    def read(url, offset: "-1", live: false, format: :auto, context: default_context, **options)
      stream(url, context: context).read(offset: offset, live: live, format: format, **options)
    end

    private

    # Deep freeze an object and all nested mutable objects
    def deep_freeze(obj)
      case obj
      when Hash
        obj.each { |k, v| deep_freeze(k); deep_freeze(v) }
      when Array
        obj.each { |v| deep_freeze(v) }
      end
      obj.freeze
    end
  end

  # Default logger - outputs warnings and errors to stderr
  # Set to nil to disable, or replace with your own logger
  self.logger = Logger.new($stderr, level: Logger::WARN)
end
