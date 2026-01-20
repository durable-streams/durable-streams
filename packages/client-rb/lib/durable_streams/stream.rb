# frozen_string_literal: true

require "json"

module DurableStreams
  # Stream handle for read/write operations on a durable stream.
  class Stream
    attr_reader :url, :content_type

    # @param url [String] Stream URL or path (resolved against context base_url)
    # @param context [Context] Configuration context
    # @param content_type [String, nil] Content type for the stream
    # @param headers [Hash] Additional headers (merged with context defaults)
    # @param batching [Boolean] Enable write batching (default: true)
    def initialize(url, context: DurableStreams.default_context, content_type: nil, headers: {}, batching: true)
      @url = context.resolve_url(url)
      @context = context
      @content_type = content_type
      @instance_headers = headers || {}
      @batching = batching
      # Use mock transport if testing is installed, otherwise create real transport
      @transport = if defined?(DurableStreams::Testing) && DurableStreams::Testing.transport_if_installed
                     DurableStreams::Testing.transport_if_installed
                   else
                     HTTP::Transport.new(
                       retry_policy: context.config.retry_policy,
                       timeout: context.config.timeout
                     )
                   end
      @batch_mutex = Mutex.new
      @batch_cv = ConditionVariable.new
      @batch_queue = []
      @batch_in_flight = false
    end

    # --- Factory Methods ---

    # Create and verify stream exists
    # @param url [String] Stream URL or path
    # @param context [Context] Configuration context
    # @param headers [Hash] Additional headers
    # @return [Stream]
    def self.connect(url, context: DurableStreams.default_context, headers: {}, **options)
      stream = new(url, context: context, headers: headers, **options)
      stream.head
      stream
    end

    # Create new stream on server
    # @param url [String] Stream URL or path
    # @param content_type [Symbol, String] Content type (:json, :bytes, or MIME type)
    # @param context [Context] Configuration context
    # @param headers [Hash] Additional headers
    # @return [Stream]
    def self.create(url, content_type:, context: DurableStreams.default_context, headers: {}, ttl_seconds: nil,
                    expires_at: nil, body: nil, **options)
      ct = normalize_content_type(content_type)
      stream = new(url, context: context, content_type: ct, headers: headers, **options)
      stream.create_stream(content_type: ct, ttl_seconds: ttl_seconds, expires_at: expires_at, body: body)
      stream
    end

    # Check if a stream exists without raising
    # @param url [String] Stream URL or path
    # @param context [Context] Configuration context
    # @param headers [Hash] Additional headers
    # @return [Boolean]
    def self.exists?(url, context: DurableStreams.default_context, headers: {}, **options)
      stream = new(url, context: context, headers: headers, **options)
      stream.exists?
    end

    # Normalize content type symbol to MIME type
    def self.normalize_content_type(ct)
      case ct
      when :json then "application/json"
      when :bytes then "application/octet-stream"
      else ct.to_s
      end
    end

    # --- Metadata Operations ---

    # HEAD - Get stream metadata
    # @return [HeadResult]
    def head
      headers = resolved_headers
      request_url = @url

      response = @transport.request(:head, request_url, headers: headers)

      if response.status == 404
        raise StreamNotFoundError.new(url: @url)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @url, headers: response.headers)
      end

      @content_type = response["content-type"] if response["content-type"]

      HeadResult.new(
        exists: true,
        content_type: response["content-type"],
        next_offset: response[STREAM_NEXT_OFFSET_HEADER],
        etag: response["etag"],
        cache_control: response["cache-control"]
      )
    end

    # Check if stream exists without raising
    # @return [Boolean]
    def exists?
      head
      true
    rescue StreamNotFoundError
      false
    end

    # Check if this is a JSON stream
    # @return [Boolean]
    def json?
      head if @content_type.nil?
      DurableStreams.json_content_type?(@content_type)
    end

    # Create stream on server (PUT)
    # @param content_type [String, nil] Content type for the stream
    # @param ttl_seconds [Integer, nil] Time-to-live in seconds
    # @param expires_at [String, nil] Absolute expiry time (RFC3339)
    # @param body [String, nil] Optional initial body
    def create_stream(content_type: nil, ttl_seconds: nil, expires_at: nil, body: nil)
      headers = resolved_headers

      ct = content_type || @content_type
      headers["content-type"] = ct if ct
      headers[STREAM_TTL_HEADER] = ttl_seconds.to_s if ttl_seconds
      headers[STREAM_EXPIRES_AT_HEADER] = expires_at if expires_at

      response = @transport.request(:put, @url, headers: headers, body: body)

      if response.status == 409
        raise StreamExistsError.new(url: @url)
      end

      unless response.success?
        raise DurableStreams.error_from_status(response.status, url: @url, body: response.body,
                                               headers: response.headers)
      end

      @content_type = response["content-type"] || ct
    end

    # Delete stream (DELETE)
    def delete
      headers = resolved_headers

      response = @transport.request(:delete, @url, headers: headers)

      if response.status == 404
        raise StreamNotFoundError.new(url: @url)
      end

      return if response.success? || response.status == 204

      raise DurableStreams.error_from_status(response.status, url: @url, headers: response.headers)
    end

    # --- Write Operations ---

    # Append data to stream
    # @param data [Object] Data to append
    # @param seq [String, nil] Optional sequence number for ordering
    # @return [AppendResult]
    def append(data, seq: nil)
      if @batching
        append_with_batching(data, seq)
      else
        append_direct(data, seq)
      end
    end

    # Sync append (same as append, explicit name for clarity)
    # @param data [Object] Data to append
    # @param seq [String, nil] Optional sequence number
    # @return [AppendResult]
    def append!(data, seq: nil)
      append(data, seq: seq)
    end

    # Shovel operator for append
    # @param data [Object] Data to append
    # @return [self] Returns self for chaining
    def <<(data)
      append(data)
      self
    end

    # --- Read Operations ---

    # Read from stream
    # @param offset [String] Starting offset (default: "-1" for beginning)
    # @param live [Boolean, Symbol] Live mode (false, :auto, :long_poll, :sse)
    # @param format [Symbol] Format hint (:auto, :json, :bytes)
    # @param cursor [String, nil] Optional cursor for continuation
    # @yield [Reader] Optional block for automatic cleanup
    # @return [JsonReader, ByteReader] Reader for iterating messages
    def read(offset: "-1", live: false, format: :auto, cursor: nil, &block)
      reader = create_reader(offset: offset, live: live, format: format, cursor: cursor)

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

    # Iterate over messages (catch-up only)
    # @yield [Object] Each message
    # @return [Enumerator] If no block given
    def each(&block)
      return enum_for(:each) unless block_given?

      read(live: false).each(&block)
    end

    # Convenience: Read all current data
    # @param offset [String] Starting offset
    # @return [Array] All messages from offset to current end
    def read_all(offset: "-1")
      read(offset: offset, live: false, &:to_a)
    end

    # Shutdown the transport
    def close
      @transport.shutdown
    end

    # --- Internal Accessors ---

    attr_reader :transport, :context

    # Resolve headers for requests (used by readers)
    # @param extra [Hash] Additional headers to merge
    # @return [Hash] Resolved headers
    def resolved_headers(extra = {})
      base = HTTP.resolve_headers(@context.config.default_headers)
      base.merge(HTTP.resolve_headers(@instance_headers)).merge(extra)
    end

    private

    def create_reader(offset:, live:, format:, cursor:)
      effective_format = determine_format(format)

      case effective_format
      when :json
        JsonReader.new(self, offset: offset, live: live, cursor: cursor)
      else
        ByteReader.new(self, offset: offset, live: live, cursor: cursor)
      end
    end

    def determine_format(format)
      return format if format != :auto

      head if @content_type.nil?
      DurableStreams.json_content_type?(@content_type) ? :json : :bytes
    end

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

      flush_batch if is_leader

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
      headers = resolved_headers
      headers["content-type"] = @content_type if @content_type
      headers[STREAM_SEQ_HEADER] = seq.to_s if seq

      body = if DurableStreams.json_content_type?(@content_type)
               JSON.generate(data_items)
             else
               data_items.map { |d| d.is_a?(String) ? d : d.to_s }.join
             end

      response = @transport.request(:post, @url, headers: headers, body: body)

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
