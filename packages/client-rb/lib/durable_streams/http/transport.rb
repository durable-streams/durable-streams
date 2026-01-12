# frozen_string_literal: true

require "net/http"
require "uri"
require "json"

module DurableStreams
  module HTTP
    # HTTP transport layer with connection pooling and retry logic
    class Transport
      # Use thread-local connection pools to avoid concurrency issues
      # Each thread gets its own set of connections
      class << self
        # Get or create a persistent connection for the given URI (thread-local)
        def connection_for(uri)
          # Thread-local connection pool
          Thread.current[:durable_streams_connections] ||= {}
          pool = Thread.current[:durable_streams_connections]

          key = "#{uri.host}:#{uri.port}"
          conn = pool[key]

          if conn.nil? || !conn.started?
            conn = Net::HTTP.new(uri.host, uri.port)
            conn.use_ssl = uri.scheme == "https"
            conn.open_timeout = 10
            conn.read_timeout = 30
            conn.keep_alive_timeout = 30
            conn.start
            pool[key] = conn
          end
          conn
        end

        # Close all connections in current thread
        def close_all
          pool = Thread.current[:durable_streams_connections]
          return unless pool

          pool.each_value do |conn|
            next unless conn.started?
            begin
              conn.finish
            rescue StandardError => e
              DurableStreams.logger&.debug("Connection close error: #{e.class}: #{e.message}")
            end
          end
          pool.clear
        end

        # Reset connection for a URI in current thread
        def reset_connection(uri)
          pool = Thread.current[:durable_streams_connections]
          return unless pool

          key = "#{uri.host}:#{uri.port}"
          conn = pool.delete(key)
          return unless conn

          begin
            conn.finish
          rescue StandardError => e
            DurableStreams.logger&.debug("Connection reset error: #{e.class}: #{e.message}")
          end
        end
      end

      attr_reader :retry_policy, :timeout

      def initialize(retry_policy: nil, timeout: 30)
        @retry_policy = retry_policy || RetryPolicy.default
        @timeout = timeout
      end

      # Make a request with retry logic
      # @param method [Symbol] HTTP method (:get, :post, :put, :delete, :head)
      # @param url [String] Full URL
      # @param headers [Hash] HTTP headers
      # @param body [String, nil] Request body
      # @param stream [Boolean] Whether to stream the response
      # @return [Response]
      def request(method, url, headers: {}, body: nil, stream: false, timeout: nil)
        uri = URI.parse(url)
        request_timeout = timeout || @timeout

        attempts = 0
        last_error = nil

        loop do
          attempts += 1
          begin
            response = execute_request(method, uri, headers, body, stream, request_timeout)

            # Check if we should retry based on status
            if @retry_policy.retryable_statuses.include?(response.status) && attempts <= @retry_policy.max_retries
              delay = calculate_delay(attempts)
              sleep(delay)
              next
            end

            return response
          rescue Errno::ECONNREFUSED, Errno::ECONNRESET, Errno::EPIPE,
                 Net::OpenTimeout, Net::ReadTimeout, IOError => e
            last_error = e
            if attempts <= @retry_policy.max_retries
              delay = calculate_delay(attempts)
              sleep(delay)
              # Force new connection on retry
              Transport.reset_connection(uri)
              next
            end
            raise ConnectionError.new(e.message)
          end
        end
      end

      # Execute a single request without retry
      def execute_request(method, uri, headers, body, stream, request_timeout)
        conn = Transport.connection_for(uri)
        conn.read_timeout = request_timeout

        path = uri.path
        path = "/" if path.empty?
        path = "#{path}?#{uri.query}" if uri.query

        req = case method
              when :get then Net::HTTP::Get.new(path)
              when :post then Net::HTTP::Post.new(path)
              when :put then Net::HTTP::Put.new(path)
              when :delete then Net::HTTP::Delete.new(path)
              when :head then Net::HTTP::Head.new(path)
              else raise ArgumentError, "Unknown method: #{method}"
              end

        headers.each { |k, v| req[k] = v }
        req.body = body if body

        if stream
          # For streaming, we need to handle the response body differently
          response_body = +""
          http_response = conn.request(req) do |res|
            res.read_body { |chunk| response_body << chunk }
          end
          Response.new(http_response, response_body)
        else
          http_response = conn.request(req)
          Response.new(http_response, http_response.body)
        end
      end

      # Stream a request, yielding chunks as they arrive
      # @param method [Symbol] HTTP method
      # @param url [String] Full URL
      # @param headers [Hash] HTTP headers
      # @yield [String] Each chunk of data
      def stream_request(method, url, headers: {}, timeout: nil, &block)
        uri = URI.parse(url)
        request_timeout = timeout || @timeout

        conn = Transport.connection_for(uri)
        conn.read_timeout = request_timeout

        path = uri.path
        path = "/" if path.empty?
        path = "#{path}?#{uri.query}" if uri.query

        req = case method
              when :get then Net::HTTP::Get.new(path)
              else raise ArgumentError, "Streaming only supported for GET"
              end

        headers.each { |k, v| req[k] = v }

        conn.request(req) do |response|
          yield StreamingResponse.new(response)
        end
      end

      private

      def calculate_delay(attempt)
        delay = @retry_policy.initial_delay * (@retry_policy.multiplier**(attempt - 1))
        [delay, @retry_policy.max_delay].min
      end
    end

    # Simple response wrapper
    class Response
      attr_reader :status, :headers, :body

      def initialize(http_response, body = nil)
        @status = http_response.code.to_i
        @headers = {}
        http_response.each_header { |k, v| @headers[k.downcase] = v }
        @body = body || http_response.body || ""
      end

      def success?
        status >= 200 && status < 300
      end

      def [](header)
        @headers[header.to_s.downcase]
      end
    end

    # Streaming response for SSE
    class StreamingResponse
      attr_reader :status, :headers

      def initialize(http_response)
        @http_response = http_response
        @status = http_response.code.to_i
        @headers = {}
        http_response.each_header { |k, v| @headers[k.downcase] = v }
      end

      def success?
        status >= 200 && status < 300
      end

      def [](header)
        @headers[header.to_s.downcase]
      end

      # Read chunks from the response body
      def each_chunk(&block)
        @http_response.read_body(&block)
      end
    end

    # Build URL with query parameters
    def self.build_url(base_url, params = {})
      return base_url if params.empty?

      uri = URI.parse(base_url)
      existing_params = uri.query ? URI.decode_www_form(uri.query).to_h : {}
      merged_params = existing_params.merge(params.transform_keys(&:to_s))
      uri.query = URI.encode_www_form(merged_params) unless merged_params.empty?
      uri.to_s
    end

    # Resolve dynamic headers (support for callable values)
    def self.resolve_headers(headers)
      return {} if headers.nil?

      headers.transform_values do |v|
        v.respond_to?(:call) ? v.call : v
      end
    end

    # Resolve dynamic params (support for callable values)
    def self.resolve_params(params)
      return {} if params.nil?

      params.transform_values do |v|
        v.respond_to?(:call) ? v.call : v
      end.compact
    end
  end
end
