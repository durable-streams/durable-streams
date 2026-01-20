# frozen_string_literal: true

module DurableStreams
  # Client manages HTTP connections and provides stream handles.
  # Creates a Context internally for configuration isolation.
  # Thread-safe for concurrent use.
  class Client
    attr_reader :context

    # Open a client with block form for automatic cleanup
    # @example
    #   Client.open(base_url: "https://...") do |client|
    #     stream = client.stream("/events")
    #     # ...
    #   end # auto-closes
    # @yield [Client] The client instance
    # @return [Object] The block's return value
    def self.open(**options, &block)
      client = new(**options)
      return client unless block_given?

      begin
        yield client
      ensure
        client.close
      end
    end

    # @param base_url [String, nil] Optional base URL for relative paths
    # @param headers [Hash] Default headers (values can be strings or callables)
    # @param timeout [Numeric] Request timeout in seconds
    # @param retry_policy [RetryPolicy] Custom retry configuration
    def initialize(base_url: nil, headers: {}, timeout: 30, retry_policy: nil)
      @context = Context.new do |config|
        config.base_url = base_url
        config.default_headers = headers || {}
        config.timeout = timeout
        config.retry_policy = retry_policy if retry_policy
      end
    end

    # Get a Stream handle for the given URL
    # @param url [String] Full URL or path (if base_url set)
    # @return [Stream]
    def stream(url, **options)
      Stream.new(url, context: @context, **options)
    end

    # Shortcut: connect to existing stream
    # @param url [String] Stream URL or path
    # @return [Stream]
    def connect(url, **options)
      Stream.connect(url, context: @context, **options)
    end

    # Shortcut: create new stream on server
    # @param url [String] Stream URL or path
    # @param content_type [String] Content type for the stream
    # @return [Stream]
    def create(url, content_type:, **options)
      Stream.create(url, content_type: content_type, context: @context, **options)
    end

    # No-op close (Context doesn't hold resources)
    def close
    end
  end
end
