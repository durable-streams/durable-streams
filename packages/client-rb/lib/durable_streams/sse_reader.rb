# frozen_string_literal: true

require "json"
require "uri"
require "net/http"

module DurableStreams
  # SSE (Server-Sent Events) reader for live streaming
  class SSEReader
    attr_reader :next_offset, :cursor, :up_to_date

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
      @http_response&.instance_variable_get(:@socket)&.close rescue nil
      @connection&.finish rescue nil
    end

    def closed?
      @closed
    end

    private

    def with_reconnection
      attempts = 0
      begin
        yield
      rescue IOError, Errno::ECONNRESET, Net::ReadTimeout, Errno::EPIPE => e
        return if @closed

        attempts += 1
        return if attempts > @retry_policy.max_retries

        delay = [@retry_policy.initial_delay * (@retry_policy.multiplier**attempts),
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
      request["Accept"] = "text/event-stream"
      @stream.resolved_headers.each { |k, v| request[k] = v }

      @connection.request(request) do |response|
        status = response.code.to_i
        if status == 404
          raise StreamNotFoundError.new(url: @stream.url)
        end
        unless status >= 200 && status < 300
          raise DurableStreams.error_from_status(status, url: @stream.url)
        end
        yield response
      end
    ensure
      @connection&.finish rescue nil
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
        begin
          control = JSON.parse(data)
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
        rescue JSON::ParserError
          # Ignore malformed control events
          return nil
        end
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
