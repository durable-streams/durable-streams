# frozen_string_literal: true

require "json"

module DurableStreams
  # Stream handle for read/write operations on a durable stream.
  class Stream
    attr_reader :url, :content_type

    # @param url [String] Stream URL
    # @param headers [Hash] Request headers (values can be strings or callables)
    # @param params [Hash] Query parameters (values can be strings or callables)
    # @param content_type [String, nil] Content type for the stream
    # @param client [Client, nil] Parent client (optional)
    # @param batching [Boolean] Enable write batching (default: true)
    def initialize(url:, headers: {}, params: {}, content_type: nil, client: nil, batching: true)
      @url = url
      @headers = headers || {}
      @params = params || {}
      @content_type = content_type
      @client = client
      @batching = batching
      @transport = client&.transport || HTTP::Transport.new
      @batch_mutex = Mutex.new
      @batch_cv = ConditionVariable.new
      @batch_queue = []
      @batch_in_flight = false
    end

    # --- Factory Methods ---

    # Create and verify stream exists
    # @param url [String] Stream URL
    # @return [Stream]
    def self.connect(url:, **options)
      stream = new(url: url, **options)
      stream.head # Validates existence and populates content_type
      stream
    end

    # Create new stream on server
    # @param url [String] Stream URL
    # @param content_type [String] Content type for the stream
    # @return [Stream]
    def self.create(url:, content_type: nil, ttl_seconds: nil, expires_at: nil, body: nil, **options)
      stream = new(url: url, content_type: content_type, **options)
      stream.create_stream(content_type: content_type, ttl_seconds: ttl_seconds,
                           expires_at: expires_at, body: body)
      stream
    end

    # --- Metadata Operations ---

    # HEAD - Get stream metadata
    # @return [HeadResult]
    def head
      resolved_headers = HTTP.resolve_headers(@headers)
      resolved_params = HTTP.resolve_params(@params)
      request_url = HTTP.build_url(@url, resolved_params)

      response = @transport.request(:head, request_url, headers: resolved_headers)

      if response.status == 404
        raise StreamNotFoundError.new(url: @url)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @url, headers: response.headers)
      end

      # Update instance content type from response
      @content_type = response["content-type"] if response["content-type"]

      HeadResult.new(
        exists: true,
        content_type: response["content-type"],
        next_offset: response[STREAM_NEXT_OFFSET_HEADER],
        etag: response["etag"],
        cache_control: response["cache-control"]
      )
    end

    # Create stream on server (PUT)
    # @param content_type [String, nil] Content type for the stream
    # @param ttl_seconds [Integer, nil] Time-to-live in seconds
    # @param expires_at [String, nil] Absolute expiry time (RFC3339)
    # @param body [String, nil] Optional initial body
    def create_stream(content_type: nil, ttl_seconds: nil, expires_at: nil, body: nil)
      resolved_headers = HTTP.resolve_headers(@headers)
      resolved_params = HTTP.resolve_params(@params)
      request_url = HTTP.build_url(@url, resolved_params)

      ct = content_type || @content_type
      resolved_headers["content-type"] = ct if ct
      resolved_headers[STREAM_TTL_HEADER] = ttl_seconds.to_s if ttl_seconds
      resolved_headers[STREAM_EXPIRES_AT_HEADER] = expires_at if expires_at

      response = @transport.request(:put, request_url, headers: resolved_headers, body: body)

      if response.status == 409
        raise StreamExistsError.new(url: @url)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @url, body: response.body,
                                               headers: response.headers)
      end

      # Update content type from response or request
      @content_type = response["content-type"] || ct
    end

    # Delete stream (DELETE)
    def delete
      resolved_headers = HTTP.resolve_headers(@headers)
      resolved_params = HTTP.resolve_params(@params)
      request_url = HTTP.build_url(@url, resolved_params)

      response = @transport.request(:delete, request_url, headers: resolved_headers)

      if response.status == 404
        raise StreamNotFoundError.new(url: @url)
      end

      return if response.success? || response.status == 204

      raise DurableStreams.error_from_status(response.status, url: @url, headers: response.headers)
    end

    # --- Write Operations ---

    # Append data to stream
    # @param data [Object] Data to append (bytes, string, or JSON-serializable for JSON streams)
    # @param seq [String, nil] Optional sequence number for ordering
    # @return [AppendResult]
    def append(data, seq: nil)
      if @batching
        append_with_batching(data, seq)
      else
        append_direct(data, seq)
      end
    end

    # --- Read Operations ---

    # Read JSON messages
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode (:long_poll, :sse, :auto, false)
    # @return [JsonReader]
    def read_json(offset: "-1", live: :auto, cursor: nil, &block)
      reader = JsonReader.new(self, offset: offset, live: live, cursor: cursor)
      if block_given?
        begin
          yield reader
        ensure
          reader.close
        end
      else
        reader
      end
    end

    # Read raw bytes
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode (:long_poll, :sse, :auto, false)
    # @return [ByteReader]
    def read_bytes(offset: "-1", live: :auto, cursor: nil, &block)
      reader = ByteReader.new(self, offset: offset, live: live, cursor: cursor)
      if block_given?
        begin
          yield reader
        ensure
          reader.close
        end
      else
        reader
      end
    end

    # Auto-select reader based on content_type
    # @param offset [String] Starting offset
    # @param live [Symbol, false] Live mode
    # @return [JsonReader, ByteReader]
    def read(offset: "-1", live: :auto, cursor: nil, &block)
      # If we don't know content type yet, do a HEAD
      head if @content_type.nil?

      if DurableStreams.json_content_type?(@content_type)
        read_json(offset: offset, live: live, cursor: cursor, &block)
      else
        read_bytes(offset: offset, live: live, cursor: cursor, &block)
      end
    end

    # Convenience: Read all current data (catch-up only)
    # @param offset [String] Starting offset
    # @return [Array] All messages from offset to current end
    def read_all(offset: "-1")
      reader = read(offset: offset, live: false)
      result = reader.to_a
      reader.close
      result
    end

    # Convenience: Subscribe to live updates with a block
    # @yield [message] Each message as it arrives
    def subscribe(offset: "-1", live: :auto, &block)
      read(offset: offset, live: live).each(&block)
    end

    # --- Internal Accessors ---

    attr_reader :transport

    def resolved_headers(extra = {})
      HTTP.resolve_headers(@headers).merge(extra)
    end

    def resolved_params(extra = {})
      HTTP.resolve_params(@params).merge(extra)
    end

    private

    def append_direct(data, seq)
      post_append([data], seq: seq)
    end

    def append_with_batching(data, seq)
      queue_entry = { data: data, seq: seq, result: nil, error: nil, done: false }
      is_leader = false

      @batch_mutex.synchronize do
        @batch_queue << queue_entry
        unless @batch_in_flight
          @batch_in_flight = true
          is_leader = true
        end
      end

      if is_leader
        flush_batch
      end

      # Wait for result using ConditionVariable (efficient, no CPU spin)
      @batch_mutex.synchronize do
        @batch_cv.wait(@batch_mutex) until queue_entry[:done]
      end

      raise queue_entry[:error] if queue_entry[:error]

      queue_entry[:result]
    end

    def flush_batch
      loop do
        messages = nil
        @batch_mutex.synchronize do
          if @batch_queue.empty?
            @batch_in_flight = false
            return
          end
          messages = @batch_queue.dup
          @batch_queue.clear
        end

        begin
          result = send_batch(messages)
          @batch_mutex.synchronize do
            messages.each do |msg|
              msg[:result] = result
              msg[:done] = true
            end
            @batch_cv.broadcast
          end
        rescue StandardError => e
          @batch_mutex.synchronize do
            messages.each do |msg|
              msg[:error] = e
              msg[:done] = true
            end
            # Also fail any messages that arrived while we were sending
            # to prevent them from waiting forever
            @batch_queue.each do |msg|
              msg[:error] = e
              msg[:done] = true
            end
            @batch_queue.clear
            @batch_in_flight = false
            @batch_cv.broadcast
          end
          return
        end
      end
    end

    def send_batch(messages)
      highest_seq = messages.reverse.find { |m| m[:seq] }&.fetch(:seq)
      post_append(messages.map { |m| m[:data] }, seq: highest_seq)
    end

    def post_append(data_items, seq: nil)
      headers = HTTP.resolve_headers(@headers)
      headers["content-type"] = @content_type if @content_type
      headers[STREAM_SEQ_HEADER] = seq.to_s if seq

      body = if DurableStreams.json_content_type?(@content_type)
               JSON.generate(data_items)
             else
               data_items.map { |d| d.is_a?(String) ? d : d.to_s }.join
             end

      request_url = HTTP.build_url(@url, HTTP.resolve_params(@params))
      response = @transport.request(:post, request_url, headers: headers, body: body)

      if response.status == 409
        raise SeqConflictError.new(url: @url)
      end

      unless response.success? || response.status == 204
        raise DurableStreams.error_from_status(response.status, url: @url, body: response.body,
                                               headers: response.headers)
      end

      next_offset = response[STREAM_NEXT_OFFSET_HEADER]
      raise FetchError.new("Server did not return #{STREAM_NEXT_OFFSET_HEADER} header", url: @url) unless next_offset

      AppendResult.new(next_offset: next_offset)
    end
  end
end
