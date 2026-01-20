# frozen_string_literal: true

module DurableStreams
  # Reader for byte streams - yields raw chunks
  class ByteReader
    attr_reader :next_offset, :cursor, :up_to_date, :status

    # @param stream [Stream] Parent stream handle
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode (:long_poll, :sse, false)
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
    end

    # Iterate over byte chunks
    # @yield [ByteChunk] Each chunk with data, next_offset, cursor, up_to_date
    def each(&block)
      return enum_for(:each) unless block_given?

      loop do
        break if @closed

        chunk = fetch_next_chunk
        break if chunk.nil?

        @next_offset = chunk.next_offset
        @cursor = chunk.cursor
        @up_to_date = chunk.up_to_date

        yield chunk

        # Break for non-live modes when up_to_date
        break if @live == false && @up_to_date
        # Break for long-poll on 204 timeout (up_to_date with empty data = no new data)
        break if @live == :long_poll && @up_to_date && chunk.data.empty? && @status == 204
        break if @closed
      end
    end

    # Accumulate all bytes until up_to_date
    # @return [String]
    def body
      chunks = []
      each { |chunk| chunks << chunk.data }
      chunks.join
    end

    # Get as text
    # @return [String]
    def text
      body.encode("UTF-8")
    end

    # Collect chunks as array
    def to_a
      result = []
      each { |chunk| result << chunk }
      result
    end

    # Cancel/close the reader
    def close
      @closed = true
    end

    def closed?
      @closed
    end

    def up_to_date?
      @up_to_date
    end

    private

    def fetch_next_chunk
      params = { offset: @next_offset }
      params[:cursor] = @cursor if @cursor

      # Add live mode parameter
      case @live
      when :long_poll
        params[:live] = "long-poll"
      when :sse
        raise SSENotSupportedError.new(content_type: @stream.content_type)
      when :auto
        # Auto mode: long-poll when up-to-date to wait for new data
        params[:live] = "long-poll" if @up_to_date
      when false
        # No live param for catch-up only
      end

      request_url = HTTP.build_url(@stream.url, params)
      headers = @stream.resolved_headers

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
        return ByteChunk.new(data: "", next_offset: @next_offset, cursor: @cursor, up_to_date: true)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @stream.url, body: response.body,
                                               headers: response.headers)
      end

      headers = DurableStreams.parse_stream_headers(response, next_offset: @next_offset, cursor: @cursor)
      @next_offset = headers[:next_offset]
      @cursor = headers[:cursor]
      @up_to_date = headers[:up_to_date]

      ByteChunk.new(
        data: response.body || "",
        next_offset: @next_offset,
        cursor: @cursor,
        up_to_date: @up_to_date
      )
    end
  end
end
