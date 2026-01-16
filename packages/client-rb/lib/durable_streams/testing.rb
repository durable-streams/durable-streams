# frozen_string_literal: true

module DurableStreams
  # Testing utilities for DurableStreams.
  # Provides mock transport and matchers for testing without a real server.
  module Testing
    # Mock response for testing
    class MockResponse
      attr_reader :status, :body, :headers

      def initialize(status:, body: "", headers: {})
        @status = status
        @body = body
        @headers = headers.transform_keys(&:downcase)
      end

      def success?
        status >= 200 && status < 300
      end

      def [](header)
        @headers[header.to_s.downcase]
      end
    end

    # Mock transport for testing without a real server
    class MockTransport
      attr_reader :requests, :streams

      def initialize
        @requests = []
        @streams = {}
        @responses = {}
        @default_offset = "0"
      end

      # Record a request and return a mock response
      def request(method, url, headers: {}, body: nil, **_options)
        uri = URI.parse(url)
        path = uri.path

        @requests << {
          method: method,
          url: url,
          path: path,
          headers: headers,
          body: body
        }

        # Return configured response or generate a default
        response_key = "#{method}:#{path}"
        if @responses[response_key]
          @responses[response_key]
        else
          default_response(method, path, body)
        end
      end

      # Stream request (simplified mock - just yields response)
      def stream_request(method, url, headers: {}, timeout: nil)
        response = request(method, url, headers: headers)
        yield response if block_given?
      end

      # Configure a response for a specific method and path
      # @param method [Symbol] HTTP method
      # @param path [String] URL path
      # @param status [Integer] Response status code
      # @param body [String] Response body
      # @param headers [Hash] Response headers
      def on(method, path, status:, body: "", headers: {})
        @responses["#{method}:#{path}"] = MockResponse.new(
          status: status,
          body: body,
          headers: headers
        )
      end

      # Add messages to a mock stream (for read testing)
      # @param path [String] Stream path
      # @param messages [Array] Messages to add
      def seed_stream(path, messages)
        @streams[path] ||= []
        @streams[path].concat(messages)
      end

      # Get messages for a stream
      # @param path [String] Stream path
      # @return [Array] Messages
      def messages_for(path)
        @streams[path] || []
      end

      # Clear all recorded requests and mock data
      def clear!
        @requests.clear
        @streams.clear
        @responses.clear
      end

      # No-op shutdown for mock
      def shutdown; end

      private

      def default_response(method, path, body)
        case method
        when :put
          # Stream creation
          @streams[path] ||= []
          MockResponse.new(
            status: 201,
            headers: { "content-type" => "application/json" }
          )
        when :head
          if @streams.key?(path)
            MockResponse.new(
              status: 200,
              headers: {
                "content-type" => "application/json",
                STREAM_NEXT_OFFSET_HEADER => @default_offset
              }
            )
          else
            MockResponse.new(status: 404)
          end
        when :post
          # Append
          @streams[path] ||= []
          if body
            begin
              messages = JSON.parse(body)
              @streams[path].concat(Array(messages))
            rescue JSON::ParserError
              @streams[path] << body
            end
          end
          new_offset = @streams[path].size.to_s
          MockResponse.new(
            status: 200,
            headers: { STREAM_NEXT_OFFSET_HEADER => new_offset }
          )
        when :get
          messages = @streams[path] || []
          MockResponse.new(
            status: 200,
            body: JSON.generate(messages),
            headers: {
              "content-type" => "application/json",
              STREAM_NEXT_OFFSET_HEADER => messages.size.to_s,
              STREAM_UP_TO_DATE_HEADER => "true"
            }
          )
        when :delete
          if @streams.delete(path)
            MockResponse.new(status: 204)
          else
            MockResponse.new(status: 404)
          end
        else
          MockResponse.new(status: 405)
        end
      end
    end

    class << self
      # Get the shared mock transport instance
      # @return [MockTransport]
      def mock_transport
        @mock_transport ||= MockTransport.new
      end

      # Install mock transport (replaces transport in new Streams)
      def install!
        @installed = true
        DurableStreams.reset_configuration!
      end

      # Check if testing mode is installed
      def installed?
        @installed || false
      end

      # Get transport for a stream (mock if installed, nil otherwise)
      # Called by Stream to check if mock transport should be used
      # @return [MockTransport, nil]
      def transport_if_installed
        installed? ? mock_transport : nil
      end

      # Reset testing state
      def reset!
        @mock_transport = nil
        @installed = false
        DurableStreams.reset_configuration!
      end

      # Get messages appended to a stream path
      # @param path [String] Stream path
      # @return [Array] Messages
      def messages_for(path)
        mock_transport.messages_for(path)
      end

      # Get all recorded requests
      # @return [Array<Hash>] Requests
      def requests
        mock_transport.requests
      end

      # Clear all test state
      def clear!
        mock_transport.clear!
      end
    end

    # RSpec matchers (only defined if RSpec is available)
    if defined?(RSpec)
      require "rspec/expectations"

      RSpec::Matchers.define :have_appended_to do |path|
        match do |_|
          messages = DurableStreams::Testing.messages_for(path)
          if @expected_data
            messages.any? { |m| hash_subset?(m, @expected_data) }
          else
            messages.any?
          end
        end

        chain :with do |data|
          @expected_data = data
        end

        failure_message do
          messages = DurableStreams::Testing.messages_for(path)
          if @expected_data
            "expected to find message matching #{@expected_data.inspect} in #{messages.inspect}"
          else
            "expected messages to be appended to #{path}, but none were"
          end
        end

        def hash_subset?(actual, expected)
          return actual == expected unless expected.is_a?(Hash) && actual.is_a?(Hash)

          expected.all? { |k, v| actual.key?(k.to_s) && hash_subset?(actual[k.to_s], v) }
        end
      end

      RSpec::Matchers.define :have_made_request do |method|
        match do |_|
          requests = DurableStreams::Testing.requests
          requests.any? do |req|
            matches_method = req[:method] == method
            matches_path = @to_path.nil? || req[:path] == @to_path
            matches_body = @with_body.nil? || req[:body]&.include?(@with_body.to_s)
            matches_method && matches_path && matches_body
          end
        end

        chain :to do |path|
          @to_path = path
        end

        chain :with_body do |body|
          @with_body = body
        end

        failure_message do
          requests = DurableStreams::Testing.requests
          "expected #{method} request#{@to_path ? " to #{@to_path}" : ""}, but got: #{requests.map { |r| "#{r[:method]} #{r[:path]}" }}"
        end
      end
    end
  end
end
