# frozen_string_literal: true

require "net/http/persistent"
require "uri"
require "json"

module DurableStreams
  module HTTP
    # HTTP transport layer using net-http-persistent for connection pooling
    class Transport
      attr_reader :retry_policy, :timeout

      def initialize(retry_policy: nil, timeout: 30, name: "durable_streams")
        @retry_policy = retry_policy || RetryPolicy.default
        @timeout = timeout
        @http = Net::HTTP::Persistent.new(name: name)
        @http.open_timeout = 10
        @http.read_timeout = timeout
        @http.idle_timeout = 30
      end

      # Make a request with retry logic
      # @param method [Symbol] HTTP method (:get, :post, :put, :delete, :head)
      # @param url [String] Full URL
      # @param headers [Hash] HTTP headers
      # @param body [String, nil] Request body
      # @param stream [Boolean] Whether to stream the response (ignored, use stream_request instead)
      # @param timeout [Integer, nil] Request-specific timeout
      # @return [Response]
      def request(method, url, headers: {}, body: nil, stream: false, timeout: nil)
        uri = URI.parse(url)
        request_timeout = timeout || @timeout

        attempts = 0
        last_error = nil

        loop do
          attempts += 1
          begin
            response = execute_request(method, uri, headers, body, request_timeout)

            # Check if we should retry based on status
            if @retry_policy.retryable_statuses.include?(response.status) && attempts <= @retry_policy.max_retries
              delay = calculate_delay(attempts)
              sleep(delay)
              next
            end

            return response
          rescue Errno::ECONNREFUSED, Errno::ECONNRESET, Errno::EPIPE,
                 Net::OpenTimeout, Net::ReadTimeout, IOError,
                 Net::HTTP::Persistent::Error => e
            last_error = e
            if attempts <= @retry_policy.max_retries
              delay = calculate_delay(attempts)
              sleep(delay)
              next
            end
            raise ConnectionError.new(
              "Failed to connect to #{uri} after #{attempts} attempts: #{e.class}: #{e.message}"
            )
          end
        end
      end

      # Stream a request, yielding the response for chunk-by-chunk reading
      # @param method [Symbol] HTTP method
      # @param url [String] Full URL
      # @param headers [Hash] HTTP headers
      # @param timeout [Integer, nil] Request-specific timeout
      # @yield [StreamingResponse] The streaming response
      def stream_request(method, url, headers: {}, timeout: nil, &block)
        uri = URI.parse(url)
        request_timeout = timeout || @timeout

        # Temporarily adjust read timeout for streaming
        original_timeout = @http.read_timeout
        @http.read_timeout = request_timeout

        req = build_request(method, uri, headers, nil)

        begin
          @http.request(uri, req) do |http_response|
            yield StreamingResponse.new(http_response)
          end
        rescue Errno::ECONNREFUSED, Errno::ECONNRESET, Errno::EPIPE,
               Net::OpenTimeout, Net::ReadTimeout, IOError,
               Net::HTTP::Persistent::Error => e
          raise ConnectionError.new("Streaming request to #{uri} failed: #{e.class}: #{e.message}")
        end
      ensure
        @http.read_timeout = original_timeout if original_timeout
      end

      # Shutdown the persistent connection pool
      def shutdown
        @http.shutdown
      end

      private

      def execute_request(method, uri, headers, body, request_timeout)
        # Temporarily adjust read timeout if different from default
        original_timeout = @http.read_timeout
        @http.read_timeout = request_timeout if request_timeout != original_timeout

        req = build_request(method, uri, headers, body)
        http_response = @http.request(uri, req)

        Response.new(http_response, http_response.body)
      ensure
        @http.read_timeout = original_timeout if request_timeout != original_timeout
      end

      def build_request(method, uri, headers, body)
        path = uri.request_uri

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

        req
      end

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
