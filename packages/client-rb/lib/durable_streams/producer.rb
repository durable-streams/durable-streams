# frozen_string_literal: true

require "json"

module DurableStreams
  # Producer for exactly-once writes with batching.
  # Uses producer_id, epoch, and sequence numbers to ensure exactly-once delivery.
  class Producer
    attr_reader :epoch, :seq

    # Open a producer with block form for automatic cleanup
    # @example
    #   Producer.open(url: "...", producer_id: "...") do |producer|
    #     producer << data
    #   end # auto flush/close
    # @yield [Producer] The producer instance
    # @return [Object] The block's return value
    def self.open(**options, &block)
      producer = new(**options)
      return producer unless block_given?

      begin
        yield producer
      ensure
        # Preserve original exception if close also raises
        begin
          producer.close
        rescue StandardError => close_error
          raise unless $!  # Re-raise close error if no original exception

          DurableStreams.logger&.warn(
            "Error during producer close (original exception preserved): #{close_error.class}: #{close_error.message}"
          )
        end
      end
    end

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

      @seq = -1  # Start at -1 so first message has seq=0 after increment
      @pending = []
      @mutex = Mutex.new
      @send_mutex = Mutex.new  # Ensure batches are sent in order
      @in_flight = 0
      @in_flight_cv = ConditionVariable.new
      @transport = HTTP::Transport.new
      @closed = false
      @linger_timer = nil
      @linger_cancelled = false
      @batch_queue = Queue.new
      @sender_thread = nil
      @last_error = nil
    end

    # Append a message (fire-and-forget, batched)
    # @param data [Object] Data to append
    def append(data)
      raise ClosedError.new("Producer is closed", url: @url) if @closed

      batch_to_send = nil
      @mutex.synchronize do
        @seq += 1
        @pending << { data: data, seq: @seq }

        # Start linger timer if this is first message in batch
        start_linger_timer if @pending.size == 1 && @linger_ms > 0

        # Flush if batch is full
        if batch_size_bytes >= @max_batch_bytes
          batch_to_send = @pending.dup
          @pending.clear
          cancel_linger_timer
        end
      end

      # Send outside the mutex to avoid blocking other appends
      queue_batch(batch_to_send) if batch_to_send
    end

    # Shovel operator for append (Ruby idiom)
    # @param data [Object] Data to append
    # @return [self] Returns self for chaining
    def <<(data)
      append(data)
      self
    end

    # Append and wait for acknowledgment (sync/blocking)
    # @param data [Object] Data to append
    # @return [ProducerResult]
    def append!(data)
      append(data)
      flush
      ProducerResult.new(
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
        # Check for errors from background threads
        raise @last_error if @last_error

        return if @pending.empty?

        batch = @pending.dup
        @pending.clear
      end

      # Send synchronously for flush
      send_batch_sync(batch) if batch && !batch.empty?

      # Wait for all in-flight batches to complete
      wait_for_inflight

      # Check for errors that occurred during wait
      @mutex.synchronize { raise @last_error if @last_error }
    end

    # Close the producer, flushing pending data
    def close
      return if @closed

      @closed = true
      cancel_linger_timer
      flush

      # Signal sender thread to stop and wait for it
      if @sender_thread&.alive?
        @batch_queue << :shutdown
        @sender_thread.join(5) # Wait up to 5 seconds
        @sender_thread.kill if @sender_thread.alive? # Force kill if stuck
      end
    end

    # Check if the producer has been closed
    # @return [Boolean]
    def closed?
      @closed
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

      @linger_cancelled = false
      @linger_timer = Thread.new do
        begin
          sleep(@linger_ms / 1000.0)
          flush unless @closed || @linger_cancelled
        rescue StandardError => e
          @mutex.synchronize do
            if @last_error
              DurableStreams.logger&.warn(
                "Additional error in linger timer (first error already recorded): #{e.class}: #{e.message}"
              )
            else
              @last_error = e
            end
          end
        end
      end
    end

    def cancel_linger_timer
      @linger_cancelled = true
      @linger_timer&.kill
      @linger_timer = nil
    end

    def queue_batch(batch)
      return if batch.nil? || batch.empty?

      # If max_in_flight is 1 or linger_ms is 0, send synchronously for ordering
      if @max_in_flight <= 1 || @linger_ms == 0
        send_batch_sync(batch)
      else
        # For batched mode with concurrency, use the queue
        start_sender_thread
        @batch_queue << batch
      end
    end

    def start_sender_thread
      return if @sender_thread&.alive?

      @sender_thread = Thread.new do
        begin
          loop do
            batch = @batch_queue.pop
            break if batch == :shutdown

            send_batch_sync(batch)
          end
        rescue StandardError => e
          DurableStreams.logger&.error(
            "Sender thread died unexpectedly: #{e.class}: #{e.message}"
          )
          @mutex.synchronize do
            if @last_error
              DurableStreams.logger&.warn(
                "Sender thread error (first error already recorded): #{e.class}: #{e.message}"
              )
            else
              @last_error = e
            end
          end
        end
      end
    end

    def wait_for_inflight
      @mutex.synchronize do
        while @in_flight > 0
          @in_flight_cv.wait(@mutex, 0.1)
        end
      end
    end

    def send_batch_sync(batch, retry_count: 0)
      return if batch.empty?

      # Serialize batch sending to ensure sequence order
      @send_mutex.synchronize do
        # Wait for in-flight slot
        @mutex.synchronize do
          while @in_flight >= @max_in_flight
            @in_flight_cv.wait(@mutex, 0.1)
          end
          @in_flight += 1
        end

        begin
          send_batch_request(batch)
        rescue StaleEpochError => e
          if @auto_claim && retry_count < 3
            new_epoch = nil
            new_batch = nil
            @mutex.synchronize do
              # Use the server's current epoch + 1, or at minimum our epoch + 1
              server_epoch = e.current_epoch || @epoch
              new_epoch = [server_epoch + 1, @epoch + 1].max
              @epoch = new_epoch
              # Rebuild the batch with seq starting from 0 for the new epoch
              new_batch = batch.each_with_index.map do |msg, idx|
                { data: msg[:data], seq: idx }
              end
              # Update @seq to the last seq in the batch so subsequent appends continue correctly
              # Any pending messages will be re-sequenced on next flush
              @seq = new_batch.size - 1
              # Re-sequence any pending messages to continue after the batch
              @pending.each_with_index do |msg, idx|
                msg[:seq] = @seq + 1 + idx
              end
              @seq += @pending.size
            end
            send_batch_request_with_epoch(new_batch, new_epoch)
          else
            raise
          end
        ensure
          @mutex.synchronize do
            @in_flight -= 1
            @in_flight_cv.broadcast
          end
        end
      end
    end

    def send_batch_request(batch)
      send_batch_request_with_epoch(batch, @epoch)
    end

    def send_batch_request_with_epoch(batch, epoch)
      headers = HTTP.resolve_headers(@headers)
      headers["content-type"] = @content_type
      headers[PRODUCER_ID_HEADER] = @producer_id
      headers[PRODUCER_EPOCH_HEADER] = epoch.to_s

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
        # Success
        nil
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
