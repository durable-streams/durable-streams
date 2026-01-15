# frozen_string_literal: true

require "json"

module DurableStreams
  # Reader for JSON streams - yields parsed Ruby objects
  class JsonReader
    attr_reader :next_offset, :cursor, :up_to_date, :status

    # @param stream [Stream] Parent stream handle
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode (:long_poll, :sse, :auto, false)
    # @param cursor [String, nil] Initial cursor
    def initialize(stream, offset: "-1", live: :auto, cursor: nil)
      @stream = stream
      @offset = DurableStreams.normalize_offset(offset)
      @live = live
      @next_offset = @offset
      @cursor = cursor
      @up_to_date = false
      @closed = false
      @status = nil
      @sse_reader = nil
    end

    # Iterate over individual JSON messages
    # @yield [Object] Each parsed JSON message
    def each(&block)
      return enum_for(:each) unless block_given?

      each_batch do |batch|
        batch.items.each(&block)
      end
    end

    # Iterate over batches with metadata
    # @yield [JsonBatch] Each batch with items, next_offset, cursor, up_to_date
    def each_batch(&block)
      return enum_for(:each_batch) unless block_given?

      # Handle SSE mode
      if use_sse?
        each_batch_sse(&block)
        return
      end

      loop do
        break if @closed

        batch = fetch_next_json_batch
        break if batch.nil?

        @next_offset = batch.next_offset
        @cursor = batch.cursor
        @up_to_date = batch.up_to_date

        yield batch

        # Break for non-live modes when up_to_date
        break if @live == false && @up_to_date
        # Break for long-poll on 204 timeout (up_to_date with empty items = no new data)
        break if @live == :long_poll && @up_to_date && batch.items.empty? && @status == 204
        break if @closed
      end
    end

    # Collect all messages until up_to_date
    # @return [Array]
    def to_a
      result = []
      each { |msg| result << msg }
      result
    end

    # Cancel/close the reader
    def close
      @closed = true
      @sse_reader&.close
    end

    def closed?
      @closed
    end

    def up_to_date?
      @up_to_date
    end

    private

    def use_sse?
      @live == :sse || (@live == :auto && DurableStreams.sse_compatible?(@stream.content_type))
    end

    def fetch_next_json_batch
      params = { offset: @next_offset }
      params[:cursor] = @cursor if @cursor

      # Add live mode parameter
      case @live
      when :long_poll
        params[:live] = "long-poll"
      when :sse
        # SSE is handled separately
        return nil
      when :auto
        # Auto mode: long-poll when up-to-date to wait for new data
        params[:live] = "long-poll" if @up_to_date
      when false
        # No live param for catch-up only
      end

      request_url = HTTP.build_url(@stream.url, params)
      headers = @stream.resolved_headers("accept" => "application/json")

      response = @stream.transport.request(:get, request_url, headers: headers)
      @status = response.status

      if response.status == 404
        raise StreamNotFoundError.new(url: @stream.url)
      end

      # Handle 204 No Content (long-poll timeout)
      # Still parse headers as they contain offset info
      if response.status == 204
        @next_offset = response[STREAM_NEXT_OFFSET_HEADER] || @next_offset
        @cursor = response[STREAM_CURSOR_HEADER] || @cursor
        @up_to_date = true
        return JsonBatch.new(items: [], next_offset: @next_offset, cursor: @cursor, up_to_date: true)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @stream.url, body: response.body,
                                               headers: response.headers)
      end

      headers = DurableStreams.parse_stream_headers(response, next_offset: @next_offset, cursor: @cursor)
      @next_offset = headers[:next_offset]
      @cursor = headers[:cursor]
      @up_to_date = headers[:up_to_date]

      # Parse JSON body
      items = if response.body && !response.body.empty?
                begin
                  JSON.parse(response.body)
                rescue JSON::ParserError => e
                  raise ParseError.new(
                    "Invalid JSON response from server: #{e.message}"
                  )
                end
              else
                []
              end

      # Ensure items is an array
      items = [items] unless items.is_a?(Array)

      JsonBatch.new(
        items: items,
        next_offset: @next_offset,
        cursor: @cursor,
        up_to_date: @up_to_date
      )
    end

    def each_batch_sse(&block)
      @sse_reader = SSEReader.new(
        @stream,
        offset: @next_offset,
        cursor: @cursor
      )

      @sse_reader.each_event do |event|
        break if @closed

        @next_offset = event[:next_offset] if event[:next_offset]
        @cursor = event[:cursor] if event[:cursor]
        @up_to_date = event[:up_to_date]
        @status = 200

        # Only yield if there's data
        if event[:data] && !event[:data].empty?
          begin
            items = JSON.parse(event[:data])
          rescue JSON::ParserError => e
            raise ParseError.new(
              "Invalid JSON in SSE event: #{e.message}"
            )
          end
          items = [items] unless items.is_a?(Array)

          batch = JsonBatch.new(
            items: items,
            next_offset: @next_offset,
            cursor: @cursor,
            up_to_date: @up_to_date
          )
          yield batch
        elsif event[:up_to_date]
          # Yield empty batch on control event with up_to_date
          batch = JsonBatch.new(
            items: [],
            next_offset: @next_offset,
            cursor: @cursor,
            up_to_date: @up_to_date
          )
          yield batch
        end
      end
    ensure
      @sse_reader&.close
    end
  end
end
