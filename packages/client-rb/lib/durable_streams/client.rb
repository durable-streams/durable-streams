# frozen_string_literal: true

module DurableStreams
  # Client manages HTTP connections and provides stream handles.
  # Thread-safe for concurrent use.
  class Client
    attr_reader :base_url, :headers, :params, :timeout, :retry_policy

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
    # @param params [Hash] Default query params (values can be strings or callables)
    # @param timeout [Numeric] Request timeout in seconds
    # @param retry_policy [RetryPolicy] Custom retry configuration
    def initialize(base_url: nil, headers: {}, params: {}, timeout: 30, retry_policy: nil)
      @base_url = base_url&.chomp("/")
      @headers = headers || {}
      @params = params || {}
      @timeout = timeout
      @retry_policy = retry_policy || RetryPolicy.default
      @transport = HTTP::Transport.new(retry_policy: @retry_policy, timeout: @timeout)
    end

    # Get a Stream handle for the given URL
    # @param url [String] Full URL or path (if base_url set)
    # @return [Stream]
    def stream(url)
      full_url = resolve_url(url)
      Stream.new(
        url: full_url,
        headers: @headers,
        params: @params,
        client: self
      )
    end

    # Shortcut: connect to existing stream
    # @param url [String] Stream URL or path
    # @return [Stream]
    def connect(url, **options)
      full_url = resolve_url(url)
      Stream.connect(url: full_url, headers: @headers.merge(options[:headers] || {}),
                     params: @params.merge(options[:params] || {}), client: self)
    end

    # Shortcut: create new stream on server
    # @param url [String] Stream URL or path
    # @param content_type [String] Content type for the stream
    # @return [Stream]
    def create(url, content_type:, **options)
      full_url = resolve_url(url)
      Stream.create(url: full_url, content_type: content_type,
                    headers: @headers.merge(options[:headers] || {}),
                    params: @params.merge(options[:params] || {}),
                    client: self, **options.except(:headers, :params))
    end

    # Close all connections
    def close
      HTTP::Transport.close_all
    end

    # Internal: get the transport for requests
    def transport
      @transport
    end

    private

    def resolve_url(url)
      if url.start_with?("http://") || url.start_with?("https://")
        url
      elsif @base_url
        # Ensure path starts with / when joining with base_url
        path = url.start_with?("/") ? url : "/#{url}"
        "#{@base_url}#{path}"
      else
        url
      end
    end
  end
end
