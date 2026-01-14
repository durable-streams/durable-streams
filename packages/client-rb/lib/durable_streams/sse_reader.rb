# frozen_string_literal: true

require "json"
require "uri"
require "net/http"

module DurableStreams
  # SSE (Server-Sent Events) reader for live streaming
  class SSEReader
    attr_reader :next_offset, :cursor, :up_to_date, :status

    # @param stream [Stream] Parent stream handle
    # @param offset [String] Starting offset
    # @param cursor [String, nil] Initial cursor
    # @param retry_policy [RetryPolicy, nil] Retry policy for reconnection
    def initialize(stream, offset: "-1", cursor: nil, retry_policy: nil)
      @stream = stream
      @offset = offset
      @next_offset = offset
      @cursor = cursor
      @retry_policy = retry_policy || RetryPolicy.default
      @up_to_date = false
      @closed = false
      @status = nil
      @buffer = +""
      @http_response = nil
      @connection = nil
    end

    # Iterate over SSE events
    # @yield [Hash] Event with :type, :data, :next_offset, :cursor, :up_to_date
    def each_event(&block)
      return enum_for(:each_event) unless block_given?

      with_reconnection do
        open_sse_connection do |response|
          @http_response = response

          response.read_body do |chunk|
            break if @closed

            @buffer << chunk
            parse_events.each do |event|
              yield event
              break if @closed
            end
          end
        end
      end
    end

    # Close the SSE connection
    def close
      @closed = true
      begin
        @http_response&.instance_variable_get(:@socket)&.close
      rescue StandardError => e
        DurableStreams.logger&.debug("SSE socket close error (expected during cleanup): #{e.class}: #{e.message}")
      end
      begin
        @connection&.finish
      rescue StandardError => e
        DurableStreams.logger&.debug("SSE connection finish error (expected during cleanup): #{e.class}: #{e.message}")
      end
    end

    def closed?
      @closed
    end

    private

    def with_reconnection
      attempts = 0
      last_error = nil
      begin
        yield
      rescue IOError, Errno::ECONNRESET, Net::ReadTimeout, Errno::EPIPE => e
        return if @closed

        last_error = e
        attempts += 1
        if attempts > @retry_policy.max_retries
          raise ConnectionError.new("SSE connection failed after #{attempts} retries: #{e.message}")
        end

        delay = [@retry_policy.initial_delay * (@retry_policy.multiplier**(attempts - 1)),
                 @retry_policy.max_delay].min
        sleep(delay)
        @buffer = +""
        retry
      end
    end

    def open_sse_connection(&block)
      params = { offset: @next_offset, live: "sse" }
      params[:cursor] = @cursor if @cursor

      request_url = HTTP.build_url(@stream.url, @stream.resolved_params(params))
      uri = URI.parse(request_url)

      @connection = Net::HTTP.new(uri.host, uri.port)
      @connection.use_ssl = uri.scheme == "https"
      @connection.open_timeout = 10
      @connection.read_timeout = 300 # Long timeout for SSE
      @connection.start

      path = uri.path
      path = "/" if path.empty?
      path = "#{path}?#{uri.query}" if uri.query

      request = Net::HTTP::Get.new(path)
      # Apply user headers first, then force Accept header for SSE
      @stream.resolved_headers.each { |k, v| request[k] = v }
      request["Accept"] = "text/event-stream"

      @connection.request(request) do |response|
        @status = response.code.to_i
        if @status == 404
          raise StreamNotFoundError.new(url: @stream.url)
        end
        unless @status >= 200 && @status < 300
          raise DurableStreams.error_from_status(@status, url: @stream.url)
        end
        yield response
      end
    ensure
      begin
        @connection&.finish
      rescue StandardError => e
        DurableStreams.logger&.debug("SSE connection cleanup error: #{e.class}: #{e.message}")
      end
    end

    def parse_events
      events = []
      # Handle both \n\n and \r\n\r\n delimiters
      while (match = @buffer.match(/\r?\n\r?\n/))
        idx = match.begin(0)
        raw = @buffer.slice!(0, idx + match[0].length)
        event = parse_sse_event(raw)
        events << event if event
      end
      events
    end

    def parse_sse_event(raw)
      event_type = nil
      data_lines = []

      raw.each_line do |line|
        line = line.chomp
        next if line.start_with?(":") # Comment line
        next if line.empty?

        case line
        when /^event:\s*(.*)$/
          event_type = ::Regexp.last_match(1)
        when /^data:\s?(.*)$/
          data_lines << ::Regexp.last_match(1)
        when /^data$/
          data_lines << "" # Empty data line
        end
      end

      return nil if data_lines.empty? && event_type != "control"

      data = data_lines.join("\n")

      # Parse control events for metadata
      if event_type == "control"
        # Validate control event data
        if data.nil? || data.strip.empty?
          raise ParseError.new("Empty control event data")
        end

        begin
          control = JSON.parse(data)
          # Must be a JSON object
          unless control.is_a?(Hash)
            raise ParseError.new("Control event data is not a JSON object")
          end
          @next_offset = control["streamNextOffset"] if control["streamNextOffset"]
          @cursor = control["streamCursor"] if control["streamCursor"]
          @up_to_date = control["upToDate"] == true || control["streamUpToDate"] == true
          return {
            type: "control",
            data: nil, # No data payload for control events
            next_offset: @next_offset,
            cursor: @cursor,
            up_to_date: @up_to_date
          }
        rescue JSON::ParserError => e
          raise ParseError.new("Malformed control event JSON: #{e.message}")
        end
      end

      # Only process known event types: "data", "message", or nil (default)
      # Ignore unknown event types per SSE spec (forward compatibility)
      unless event_type.nil? || event_type == "data" || event_type == "message"
        return nil
      end

      {
        type: event_type,
        data: data,
        next_offset: @next_offset,
        cursor: @cursor,
        up_to_date: @up_to_date
      }
    end
  end
end
