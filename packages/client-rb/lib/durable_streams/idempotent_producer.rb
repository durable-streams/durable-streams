# frozen_string_literal: true

require "json"
require "thread"

module DurableStreams
  # Idempotent producer for exactly-once writes with batching.
  # Uses producer_id, epoch, and sequence numbers to ensure exactly-once delivery.
  class IdempotentProducer
    attr_reader :epoch, :seq

    # @param url [String] Stream URL
    # @param producer_id [String] Stable identifier for this producer
    # @param epoch [Integer] Starting epoch (increment on restart)
    # @param auto_claim [Boolean] Auto-retry with epoch+1 on 403
    # @param max_batch_bytes [Integer] Max bytes before flush (default: 1MB)
    # @param linger_ms [Integer] Max wait before flush (default: 5ms)
    # @param max_in_flight [Integer] Max concurrent batches (default: 5)
    # @param content_type [String] Content type for the stream
    # @param headers [Hash] Additional headers
    def initialize(url:, producer_id:, epoch: 0, auto_claim: false,
                   max_batch_bytes: 1_048_576, linger_ms: 5, max_in_flight: 5,
                   content_type: nil, headers: {})
      @url = url
      @producer_id = producer_id
      @epoch = epoch
      @auto_claim = auto_claim
      @max_batch_bytes = max_batch_bytes
      @linger_ms = linger_ms
      @max_in_flight = max_in_flight
      @content_type = content_type || "application/json"
      @headers = headers

      @seq = 0
      @pending = []
      @mutex = Mutex.new
      @in_flight = 0
      @transport = HTTP::Transport.new
      @closed = false
      @linger_timer = nil
    end

    # Append a message (fire-and-forget, batched)
    # @param data [Object] Data to append
    def append(data)
      raise AlreadyConsumedError if @closed

      @mutex.synchronize do
        @seq += 1
        @pending << { data: data, seq: @seq }

        # Start linger timer if this is first message in batch
        start_linger_timer if @pending.size == 1 && @linger_ms > 0

        # Flush if batch is full
        flush_pending if batch_size_bytes >= @max_batch_bytes
      end
    end

    # Append and wait for acknowledgment
    # @param data [Object] Data to append
    # @return [IdempotentAppendResult]
    def append_sync(data)
      append(data)
      flush
      IdempotentAppendResult.new(
        next_offset: nil, # We don't track individual message offsets in batched mode
        duplicate: false,
        epoch: @epoch,
        seq: @seq
      )
    end

    # Flush all pending batches
    def flush
      batch = nil
      @mutex.synchronize do
        cancel_linger_timer
        return if @pending.empty?

        batch = @pending.dup
        @pending.clear
      end

      send_batch(batch) if batch && !batch.empty?
    end

    # Close the producer, flushing pending data
    def close
      return if @closed

      @closed = true
      cancel_linger_timer
      flush
    end

    private

    def batch_size_bytes
      # Rough estimate of batch size
      @pending.sum do |msg|
        data = msg[:data]
        if data.is_a?(String)
          data.bytesize
        else
          JSON.generate(data).bytesize
        end
      end
    end

    def start_linger_timer
      return if @linger_ms <= 0

      @linger_timer = Thread.new do
        sleep(@linger_ms / 1000.0)
        flush unless @closed
      end
    end

    def cancel_linger_timer
      @linger_timer&.kill
      @linger_timer = nil
    end

    def flush_pending
      return if @pending.empty?

      batch = @pending.dup
      @pending.clear
      cancel_linger_timer

      # Send asynchronously to allow more batching
      Thread.new { send_batch(batch) }
    end

    def send_batch(batch, retry_count: 0)
      return if batch.empty?

      # Wait for in-flight slot
      loop do
        can_send = @mutex.synchronize do
          if @in_flight < @max_in_flight
            @in_flight += 1
            true
          else
            false
          end
        end
        break if can_send

        sleep(0.001)
      end

      begin
        send_batch_request(batch)
      rescue StaleEpochError => e
        if @auto_claim && retry_count < 3
          @mutex.synchronize { @epoch += 1 }
          send_batch(batch, retry_count: retry_count + 1)
        else
          raise
        end
      ensure
        @mutex.synchronize { @in_flight -= 1 }
      end
    end

    def send_batch_request(batch)
      headers = HTTP.resolve_headers(@headers)
      headers["content-type"] = @content_type
      headers[PRODUCER_ID_HEADER] = @producer_id
      headers[PRODUCER_EPOCH_HEADER] = @epoch.to_s

      # Use the first message's seq as the starting seq
      first_seq = batch.first[:seq]
      headers[PRODUCER_SEQ_HEADER] = first_seq.to_s

      # Build body
      body = if DurableStreams.json_content_type?(@content_type)
               JSON.generate(batch.map { |m| m[:data] })
             else
               batch.map { |m| m[:data].is_a?(String) ? m[:data] : m[:data].to_s }.join
             end

      response = @transport.request(:post, @url, headers: headers, body: body)

      case response.status
      when 200, 201, 204
        # Success - check for duplicate
        if response[STREAM_NEXT_OFFSET_HEADER]
          # Normal success
        end
      when 403
        # Stale epoch
        current_epoch = response[PRODUCER_EPOCH_HEADER]&.to_i
        raise StaleEpochError.new(current_epoch: current_epoch, url: @url, headers: response.headers)
      when 409
        # Could be sequence gap or other conflict
        expected = response[PRODUCER_EXPECTED_SEQ_HEADER]&.to_i
        received = response[PRODUCER_RECEIVED_SEQ_HEADER]&.to_i
        if expected && received
          raise SequenceGapError.new(expected_seq: expected, received_seq: received,
                                     url: @url, headers: response.headers)
        else
          raise SeqConflictError.new(url: @url, headers: response.headers)
        end
      else
        raise DurableStreams.error_from_status(response.status, url: @url, body: response.body,
                                               headers: response.headers)
      end
    end
  end
end
