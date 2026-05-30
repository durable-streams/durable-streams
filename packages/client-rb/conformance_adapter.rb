#!/usr/bin/env ruby
# frozen_string_literal: true

# Ruby client adapter for Durable Streams conformance testing.
#
# This adapter implements the stdin/stdout JSON-line protocol for the
# durable-streams Ruby client package.
#
# Run directly:
#   ruby conformance_adapter.rb
#
# Or via bundler:
#   bundle exec ruby conformance_adapter.rb

require "json"
require "base64"
require "time"

$LOAD_PATH.unshift(File.expand_path("lib", __dir__))
require "durable_streams"

# Error code constants matching the TypeScript protocol
module ErrorCode
  NETWORK_ERROR = "NETWORK_ERROR"
  TIMEOUT = "TIMEOUT"
  CONFLICT = "CONFLICT"
  NOT_FOUND = "NOT_FOUND"
  SEQUENCE_CONFLICT = "SEQUENCE_CONFLICT"
  INVALID_OFFSET = "INVALID_OFFSET"
  INVALID_ARGUMENT = "INVALID_ARGUMENT"
  UNEXPECTED_STATUS = "UNEXPECTED_STATUS"
  PARSE_ERROR = "PARSE_ERROR"
  INTERNAL_ERROR = "INTERNAL_ERROR"
  NOT_SUPPORTED = "NOT_SUPPORTED"
  STREAM_CLOSED = "STREAM_CLOSED"
end

# Global state
$server_url = ""
$stream_content_types = {}
$producer_next_seq = {}
$producer_stream_closed = {}

# Dynamic headers/params state
class DynamicValue
  attr_accessor :type, :counter, :token_value

  def initialize(value_type, initial_value = nil)
    @type = value_type
    @counter = 0
    @token_value = initial_value
  end

  def get_value
    case @type
    when "counter"
      @counter += 1
      @counter.to_s
    when "timestamp"
      (Time.now.to_f * 1000).to_i.to_s
    when "token"
      @token_value || ""
    else
      ""
    end
  end
end

$dynamic_headers = {}
$dynamic_params = {}

def producer_seq_key(path, producer_id, epoch)
  "#{path}|#{producer_id}|#{epoch}"
end

def producer_key(path, producer_id)
  "#{path}|#{producer_id}"
end

def drop_producer_epochs(path, producer_id)
  prefix = "#{path}|#{producer_id}|"
  $producer_next_seq.keys.each do |key|
    $producer_next_seq.delete(key) if key.start_with?(prefix)
  end
end

def clear_producer_for_path(path)
  prefix = "#{path}|"
  $producer_next_seq.keys.each do |key|
    $producer_next_seq.delete(key) if key.start_with?(prefix)
  end
  $producer_stream_closed.keys.each do |key|
    $producer_stream_closed.delete(key) if key.start_with?(prefix)
  end
end

def resolve_dynamic_values(dynamic_map)
  resolved = {}
  dynamic_map.each do |name, config|
    resolved[name] = config.get_value
  end
  [resolved.dup, resolved]
end

def resolve_dynamic_headers
  resolve_dynamic_values($dynamic_headers)
end

def resolve_dynamic_params
  resolve_dynamic_values($dynamic_params)
end

def map_error_code(err)
  case err
  when DurableStreams::ParseError
    [ErrorCode::PARSE_ERROR, nil]
  when DurableStreams::StreamNotFoundError
    [ErrorCode::NOT_FOUND, 404]
  when DurableStreams::StreamExistsError
    [ErrorCode::CONFLICT, 409]
  when DurableStreams::StreamClosedError
    [ErrorCode::STREAM_CLOSED, 409]
  when DurableStreams::SeqConflictError
    [ErrorCode::SEQUENCE_CONFLICT, 409]
  when DurableStreams::BadRequestError
    [ErrorCode::INVALID_OFFSET, 400]
  when DurableStreams::TimeoutError
    [ErrorCode::TIMEOUT, nil]
  when DurableStreams::ConnectionError
    [ErrorCode::NETWORK_ERROR, nil]
  when DurableStreams::FetchError
    status = err.status
    case status
    when 404 then [ErrorCode::NOT_FOUND, 404]
    when 409 then [ErrorCode::CONFLICT, 409]
    else [ErrorCode::UNEXPECTED_STATUS, status]
    end
  when DurableStreams::Error
    status = err.status
    [ErrorCode::UNEXPECTED_STATUS, status]
  else
    [ErrorCode::INTERNAL_ERROR, nil]
  end
end

def error_result(command_type, err)
  error_code, status = map_error_code(err)
  result = {
    "type" => "error",
    "success" => false,
    "commandType" => command_type,
    "errorCode" => error_code,
    "message" => err.message
  }
  result["status"] = status if status
  result
end

def handle_init(cmd)
  $server_url = cmd["serverUrl"]
  $stream_content_types.clear
  $dynamic_headers.clear
  $dynamic_params.clear
  $producer_next_seq.clear
  $producer_stream_closed.clear

  {
    "type" => "init",
    "success" => true,
    "clientName" => "durable-streams-ruby",
    "clientVersion" => DurableStreams::VERSION,
    "features" => {
      "batching" => true,
      "sse" => true,
      "longPoll" => true,
      "streaming" => true,
      "dynamicHeaders" => true,
      "sseBase64Encoding" => true,
      "auto" => true
    }
  }
end

def handle_create(cmd)
  url = "#{$server_url}#{cmd["path"]}"
  content_type = cmd["contentType"] || "application/octet-stream"
  closed = cmd["closed"] || false
  data = cmd["data"]
  if data && (cmd["binary"] || false)
    data = Base64.decode64(data)
  end

  # Check if stream already exists
  already_exists = false
  begin
    stream = DurableStreams::Stream.new(url)
    stream.head
    already_exists = true
  rescue DurableStreams::StreamNotFoundError
    # Expected - stream doesn't exist yet
  end

  # Create the stream
  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.create(
    url,
    content_type: content_type,
    ttl_seconds: cmd["ttlSeconds"],
    expires_at: cmd["expiresAt"],
    headers: headers,
    closed: closed,
    body: data
  )

  # Cache content type
  $stream_content_types[cmd["path"]] = content_type

  # Get the current offset
  head = stream.head

  {
    "type" => "create",
    "success" => true,
    "status" => already_exists ? 200 : 201,
    "offset" => head.next_offset
  }
end

def handle_connect(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.connect(url, headers: headers)

  head = stream.head

  # Cache content type
  $stream_content_types[cmd["path"]] = head.content_type if head.content_type

  {
    "type" => "connect",
    "success" => true,
    "status" => 200,
    "offset" => head.next_offset
  }
end

def handle_append(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  # Get content type from cache or default
  content_type = $stream_content_types[cmd["path"]] || "application/octet-stream"

  # Resolve dynamic headers/params
  dynamic_hdrs, headers_sent = resolve_dynamic_headers
  _, params_sent = resolve_dynamic_params

  # Merge command headers with dynamic headers
  cmd_headers = cmd["headers"] || {}
  merged_headers = dynamic_hdrs.merge(cmd_headers)

  # Decode data
  data = if cmd["binary"]
           Base64.decode64(cmd["data"])
         else
           cmd["data"]
         end

  # Get seq if provided
  seq = cmd["seq"]&.to_s

  # Create stream and append
  stream = DurableStreams::Stream.new(
    url,
    content_type: content_type,
    headers: merged_headers,
    batching: false
  )
  stream.append(data, seq: seq)
  head = stream.head

  result = {
    "type" => "append",
    "success" => true,
    "status" => 200,
    "offset" => head.next_offset
  }
  result["headersSent"] = headers_sent unless headers_sent.empty?
  result["paramsSent"] = params_sent unless params_sent.empty?
  result
end

def handle_read(cmd)
  url = "#{$server_url}#{cmd["path"]}"
  offset = cmd["offset"] || "-1"

  # Determine live mode
  live = case cmd["live"]
         when "long-poll" then :long_poll
         when "sse" then :sse
         when true then :long_poll # auto mode = long-poll
         when false then false
         else false # Default to catch-up only
         end

  timeout_ms = cmd["timeoutMs"] || 5000
  max_chunks = cmd["maxChunks"] || 100
  wait_for_up_to_date = cmd["waitForUpToDate"] || false

  # Resolve dynamic headers/params
  dynamic_hdrs, headers_sent = resolve_dynamic_headers
  _, params_sent = resolve_dynamic_params

  # Merge command headers with dynamic headers
  cmd_headers = cmd["headers"] || {}
  merged_headers = dynamic_hdrs.merge(cmd_headers)

  chunks = []
  final_offset = offset
  up_to_date = false
  status = 200

  content_type = $stream_content_types[cmd["path"]]
  is_json = DurableStreams.json_content_type?(content_type)
  format = is_json ? :json : :bytes

  stream = DurableStreams::Stream.new(
    url,
    content_type: content_type,
    headers: merged_headers
  )

  begin
    if live == false
      # Catch-up mode
      reader = stream.read(offset: offset, live: false, format: format)

      if is_json
        reader.each_batch do |batch|
          data = JSON.generate(batch.items)
          chunks << { "data" => data, "offset" => batch.next_offset } unless batch.items.empty?
          final_offset = batch.next_offset
          up_to_date = batch.up_to_date
        end
      else
        reader.each do |chunk|
          unless chunk.data.empty?
            # Try to return as UTF-8 string; if data contains non-UTF8 bytes, base64 encode
            chunk_entry = encode_chunk_data(chunk.data, chunk.next_offset)
            chunks << chunk_entry
          end
          final_offset = chunk.next_offset
          up_to_date = chunk.up_to_date
        end
      end
      status = reader.status || 200
      reader.close
    elsif live == :sse
      # SSE mode with timeout
      reader = stream.read(offset: offset, live: :sse, format: format)
      chunk_count = 0

      begin
        Timeout.timeout(timeout_ms / 1000.0) do
          if is_json
            reader.each_batch do |batch|
              unless batch.items.empty?
                data = JSON.generate(batch.items)
                chunks << { "data" => data, "offset" => batch.next_offset }
                chunk_count += 1
              end

              final_offset = batch.next_offset
              up_to_date = batch.up_to_date

              break if chunk_count >= max_chunks
              break if wait_for_up_to_date && up_to_date
            end
          else
            # For byte streams (server auto-encodes binary as base64)
            reader.each do |chunk|
              unless chunk.data.empty?
                # Try to return as UTF-8 string; if data contains non-UTF8 bytes, base64 encode
                chunk_entry = encode_chunk_data(chunk.data, chunk.next_offset)
                chunks << chunk_entry
                chunk_count += 1
              end

              final_offset = chunk.next_offset
              up_to_date = chunk.up_to_date

              break if chunk_count >= max_chunks
              break if wait_for_up_to_date && up_to_date
            end
          end
        end
      rescue Timeout::Error
        # Timeout is expected for SSE when waiting for data
        up_to_date = true
      end

      status = reader.status || 200
      reader.close
    else
      # Long-poll mode
      reader = stream.read(offset: offset, live: :long_poll, format: format)
      chunk_count = 0

      Timeout.timeout(timeout_ms / 1000.0) do
        if is_json
          reader.each_batch do |batch|
            unless batch.items.empty?
              data = JSON.generate(batch.items)
              chunks << { "data" => data, "offset" => batch.next_offset }
              chunk_count += 1
            end

            final_offset = batch.next_offset
            up_to_date = batch.up_to_date

            break if chunk_count >= max_chunks
            break if wait_for_up_to_date && up_to_date
          end
        else
          reader.each do |chunk|
            unless chunk.data.empty?
              # Try to return as UTF-8 string; if data contains non-UTF8 bytes, base64 encode
              chunk_entry = encode_chunk_data(chunk.data, chunk.next_offset)
              chunks << chunk_entry
              chunk_count += 1
            end

            final_offset = chunk.next_offset
            up_to_date = chunk.up_to_date

            break if chunk_count >= max_chunks
            break if wait_for_up_to_date && up_to_date
          end
        end
      end

      status = reader.status || 200
      reader.close
    end
  rescue Timeout::Error
    # Timeout is expected for long-poll
    up_to_date = true
  end

  # Check stream closed status by doing a HEAD request
  stream_closed = false
  begin
    head_result = stream.head
    stream_closed = head_result.stream_closed
  rescue StandardError
    # Ignore errors - stream_closed defaults to false
  end

  result = {
    "type" => "read",
    "success" => true,
    "status" => status,
    "chunks" => chunks,
    "offset" => final_offset,
    "upToDate" => up_to_date,
    "streamClosed" => stream_closed
  }
  result["headersSent"] = headers_sent unless headers_sent.empty?
  result["paramsSent"] = params_sent unless params_sent.empty?
  result
end

def handle_head(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.new(url, headers: headers)
  result = stream.head

  # Cache content type
  $stream_content_types[cmd["path"]] = result.content_type if result.content_type

  {
    "type" => "head",
    "success" => true,
    "status" => 200,
    "offset" => result.next_offset,
    "contentType" => result.content_type,
    "streamClosed" => result.stream_closed
  }
end

def handle_close(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  # Get content type from cache or default
  content_type = cmd["contentType"] || $stream_content_types[cmd["path"]] || "application/octet-stream"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.new(url, content_type: content_type, headers: headers)

  # Decode data if provided
  data = cmd["data"]
  if data && (cmd["binary"] || false)
    data = Base64.decode64(data)
  end

  result = stream.close_stream(data: data, content_type: content_type)

  {
    "type" => "close",
    "success" => true,
    "finalOffset" => result.final_offset
  }
end

def handle_delete(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.new(url, headers: headers)
  stream.delete

  # Remove from cache
  $stream_content_types.delete(cmd["path"])
  clear_producer_for_path(cmd["path"])

  {
    "type" => "delete",
    "success" => true,
    "status" => 200
  }
end

def handle_shutdown(_cmd)
  {
    "type" => "shutdown",
    "success" => true
  }
end

def handle_benchmark(cmd)
  require "timeout"

  iteration_id = cmd["iterationId"]
  operation = cmd["operation"]
  op_type = operation["op"]

  metrics = {}

  begin
    start_time = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)

    case op_type
    when "append"
      url = "#{$server_url}#{operation["path"]}"
      content_type = $stream_content_types[operation["path"]] || "application/octet-stream"

      stream = DurableStreams::Stream.new(url, content_type: content_type, batching: false)
      payload = "*" * operation["size"]
      stream.append(payload)
      metrics["bytesTransferred"] = operation["size"]

    when "read"
      url = "#{$server_url}#{operation["path"]}"
      offset = operation["offset"]

      stream = DurableStreams::Stream.new(url)
      reader = stream.read(offset: offset, live: false, format: :bytes)
      data = reader.body
      reader.close
      metrics["bytesTransferred"] = data.bytesize

    when "create"
      url = "#{$server_url}#{operation["path"]}"
      content_type = operation["contentType"] || "application/octet-stream"
      DurableStreams::Stream.create(url, content_type: content_type)

    when "throughput_append"
      url = "#{$server_url}#{operation["path"]}"
      content_type = $stream_content_types[operation["path"]] || "application/octet-stream"

      # Ensure stream exists
      begin
        DurableStreams::Stream.create(url, content_type: content_type)
      rescue DurableStreams::StreamExistsError
        # OK
      end

      payload = "*" * operation["size"]
      count = operation["count"]
      concurrency = operation["concurrency"]

      # Use threads for concurrency
      threads = []
      count_per_thread = count / concurrency
      remainder = count % concurrency

      concurrency.times do |i|
        thread_count = count_per_thread + (i < remainder ? 1 : 0)
        threads << Thread.new do
          stream = DurableStreams::Stream.new(url, content_type: content_type, batching: true)
          thread_count.times { stream.append(payload) }
        end
      end

      threads.each(&:join)

      metrics["bytesTransferred"] = count * operation["size"]
      metrics["messagesProcessed"] = count

    when "throughput_read"
      url = "#{$server_url}#{operation["path"]}"

      stream = DurableStreams::Stream.new(url)
      reader = stream.read(offset: "-1", live: false, format: :json)

      count = 0
      total_bytes = 0
      reader.each do |item|
        count += 1
        total_bytes += JSON.generate(item).bytesize
      end
      reader.close

      metrics["bytesTransferred"] = total_bytes
      metrics["messagesProcessed"] = count

    when "roundtrip"
      url = "#{$server_url}#{operation["path"]}"
      content_type = operation["contentType"] || "application/octet-stream"
      live_mode = operation["live"] || "long-poll"
      is_json = content_type.include?("json")

      stream = DurableStreams::Stream.create(url, content_type: content_type)

      # Generate payload
      payload = if is_json
                  { "data" => "x" * operation["size"] }
                else
                  "*" * operation["size"]
                end

      read_data = nil
      read_error = nil

      # Start reader in background
      reader_thread = Thread.new do
        begin
          live_sym = live_mode == "sse" ? :sse : :long_poll
          format = is_json ? :json : :bytes
          reader = stream.read(offset: "-1", live: live_sym, format: format)

          if is_json
            reader.each do |item|
              read_data = item
              break
            end
          else
            reader.each do |chunk|
              read_data = chunk.data
              break
            end
          end
          reader.close
        rescue StandardError => e
          read_error = e
        end
      end

      # Give reader time to connect
      sleep(0.005)

      # Append data
      stream.append(payload)

      # Wait for read
      reader_thread.join(10)

      raise read_error if read_error
      raise "Reader timed out" if reader_thread.alive?
      raise "No data received" if read_data.nil?

      read_len = is_json ? JSON.generate(read_data).bytesize : read_data.bytesize
      metrics["bytesTransferred"] = operation["size"] + read_len

    else
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "benchmark",
        "errorCode" => ErrorCode::NOT_SUPPORTED,
        "message" => "Unknown benchmark operation: #{op_type}"
      }
    end

    end_time = Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)
    duration_ns = end_time - start_time

    {
      "type" => "benchmark",
      "success" => true,
      "iterationId" => iteration_id,
      "durationNs" => duration_ns.to_s,
      "metrics" => metrics
    }
  rescue StandardError => e
    warn "[benchmark error] #{op_type}: #{e.message}"
    warn e.backtrace.join("\n")
    {
      "type" => "error",
      "success" => false,
      "commandType" => "benchmark",
      "errorCode" => ErrorCode::INTERNAL_ERROR,
      "message" => e.message
    }
  end
end

def handle_set_dynamic_header(cmd)
  name = cmd["name"]
  value_type = cmd["valueType"]
  initial_value = cmd["initialValue"]
  $dynamic_headers[name] = DynamicValue.new(value_type, initial_value)

  {
    "type" => "set-dynamic-header",
    "success" => true
  }
end

def handle_set_dynamic_param(cmd)
  name = cmd["name"]
  value_type = cmd["valueType"]
  $dynamic_params[name] = DynamicValue.new(value_type)

  {
    "type" => "set-dynamic-param",
    "success" => true
  }
end

def handle_clear_dynamic(_cmd)
  $dynamic_headers.clear
  $dynamic_params.clear

  {
    "type" => "clear-dynamic",
    "success" => true
  }
end

def handle_idempotent_append(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  content_type = $stream_content_types[cmd["path"]] || "application/octet-stream"

  producer_id = cmd["producerId"]
  epoch = cmd["epoch"] || 0
  auto_claim = cmd["autoClaim"] || false
  # Data is already pre-serialized, pass directly to append()
  data = cmd["data"]
  if data && (cmd["binary"] || false)
    data = Base64.decode64(data)
  end

  seq_key = producer_seq_key(cmd["path"], producer_id, epoch)
  next_seq = $producer_next_seq[seq_key] || 0

  producer = DurableStreams::Producer.new(
    url: url,
    producer_id: producer_id,
    epoch: epoch,
    auto_claim: auto_claim,
    max_in_flight: 1,
    linger_ms: 0,
    content_type: content_type,
    next_seq: next_seq
  )

  producer.append(data)
  producer.flush

  final_epoch = producer.epoch
  final_next_seq = producer.seq + 1
  drop_producer_epochs(cmd["path"], producer_id)
  $producer_next_seq[producer_seq_key(cmd["path"], producer_id, final_epoch)] = final_next_seq

  {
    "type" => "idempotent-append",
    "success" => true,
    "status" => 200
  }
end

def handle_idempotent_append_batch(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  content_type = $stream_content_types[cmd["path"]] || "application/octet-stream"

  producer_id = cmd["producerId"]
  epoch = cmd["epoch"] || 0
  auto_claim = cmd["autoClaim"] || false
  # Data is already pre-serialized, pass directly to append()
  items = cmd["items"]
  max_in_flight = cmd["maxInFlight"] || 1

  # When testing concurrency, use small batches
  testing_concurrency = max_in_flight > 1

  producer = DurableStreams::Producer.new(
    url: url,
    producer_id: producer_id,
    epoch: epoch,
    auto_claim: auto_claim,
    max_in_flight: max_in_flight,
    linger_ms: testing_concurrency ? 0 : 1000,
    max_batch_bytes: testing_concurrency ? 1 : 1_048_576,
    content_type: content_type
  )

  items.each { |item| producer.append(item) }
  producer.flush
  producer.close

  {
    "type" => "idempotent-append-batch",
    "success" => true,
    "status" => 200
  }
end

def handle_idempotent_close(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  content_type = cmd["contentType"] || $stream_content_types[cmd["path"]] || "application/octet-stream"

  producer_id = cmd["producerId"]
  epoch = cmd["epoch"] || 0
  auto_claim = cmd["autoClaim"] || false

  data = cmd["data"]
  if data && (cmd["binary"] || false)
    data = Base64.decode64(data)
  end

  producer_key = producer_key(cmd["path"], producer_id)
  if $producer_stream_closed[producer_key]
    return {
      "type" => "idempotent-close",
      "success" => true,
      "status" => 200
    }
  end

  seq_key = producer_seq_key(cmd["path"], producer_id, epoch)
  next_seq = $producer_next_seq[seq_key] || 0

  producer = DurableStreams::Producer.new(
    url: url,
    producer_id: producer_id,
    epoch: epoch,
    auto_claim: auto_claim,
    max_in_flight: 1,
    linger_ms: 0,
    content_type: content_type,
    next_seq: next_seq
  )

  producer.close_stream(data: data)

  final_epoch = producer.epoch
  final_next_seq = producer.seq + 1
  drop_producer_epochs(cmd["path"], producer_id)
  $producer_next_seq[producer_seq_key(cmd["path"], producer_id, final_epoch)] = final_next_seq
  $producer_stream_closed[producer_key] = true

  {
    "type" => "idempotent-close",
    "success" => true,
    "status" => 200
  }
end

def handle_idempotent_detach(cmd)
  drop_producer_epochs(cmd["path"], cmd["producerId"])
  $producer_stream_closed.delete(producer_key(cmd["path"], cmd["producerId"]))

  {
    "type" => "idempotent-detach",
    "success" => true,
    "status" => 200
  }
end

# Helper to encode chunk data for JSON response.
# Returns data as UTF-8 string if valid, otherwise base64 encodes and sets binary flag.
def encode_chunk_data(data, offset)
  # Try to convert to UTF-8
  begin
    utf8_data = data.dup.force_encoding("UTF-8")
    if utf8_data.valid_encoding?
      { "data" => utf8_data, "offset" => offset }
    else
      # Data contains non-UTF8 bytes, must base64 encode
      { "data" => Base64.strict_encode64(data), "offset" => offset, "binary" => true }
    end
  rescue StandardError
    # Any encoding error means we should base64 encode
    { "data" => Base64.strict_encode64(data), "offset" => offset, "binary" => true }
  end
end

def validation_error(message)
  {
    "type" => "error",
    "success" => false,
    "commandType" => "validate",
    "errorCode" => ErrorCode::INVALID_ARGUMENT,
    "message" => message
  }
end

def validation_success
  { "type" => "validate", "success" => true }
end

def handle_validate(cmd)
  target = cmd["target"]
  target_type = target["target"]

  case target_type
  when "idempotent-producer"
    epoch = target["epoch"] || 0
    max_batch_bytes = target["maxBatchBytes"] || 1_048_576

    return validation_error("epoch must be non-negative, got: #{epoch}") if epoch < 0
    return validation_error("maxBatchBytes must be positive, got: #{max_batch_bytes}") if max_batch_bytes < 1

    validation_success

  else
    {
      "type" => "error",
      "success" => false,
      "commandType" => "validate",
      "errorCode" => ErrorCode::NOT_SUPPORTED,
      "message" => "Unknown validation target: #{target_type}"
    }
  end
end

def handle_command(cmd)
  cmd_type = cmd["type"]

  begin
    case cmd_type
    when "init" then handle_init(cmd)
    when "create" then handle_create(cmd)
    when "connect" then handle_connect(cmd)
    when "append" then handle_append(cmd)
    when "read" then handle_read(cmd)
    when "head" then handle_head(cmd)
    when "close" then handle_close(cmd)
    when "delete" then handle_delete(cmd)
    when "shutdown" then handle_shutdown(cmd)
    when "benchmark" then handle_benchmark(cmd)
    when "set-dynamic-header" then handle_set_dynamic_header(cmd)
    when "set-dynamic-param" then handle_set_dynamic_param(cmd)
    when "clear-dynamic" then handle_clear_dynamic(cmd)
    when "idempotent-append" then handle_idempotent_append(cmd)
    when "idempotent-append-batch" then handle_idempotent_append_batch(cmd)
    when "idempotent-close" then handle_idempotent_close(cmd)
    when "idempotent-detach" then handle_idempotent_detach(cmd)
    when "validate" then handle_validate(cmd)
    else
      {
        "type" => "error",
        "success" => false,
        "commandType" => cmd_type,
        "errorCode" => ErrorCode::NOT_SUPPORTED,
        "message" => "Unknown command type: #{cmd_type}"
      }
    end
  rescue StandardError => e
    error_result(cmd_type, e)
  end
end

# Main entry point
def main
  $stdin.binmode
  $stdin.set_encoding("UTF-8")
  $stdout.binmode
  $stdout.set_encoding("UTF-8")

  $stdin.each_line do |line|
    line = line.encode("UTF-8", invalid: :replace, undef: :replace).strip
    next if line.empty?

    begin
      command = JSON.parse(line)
      result = handle_command(command)
      # Generate JSON and escape U+2028/U+2029 which are line terminators
      # that can break JavaScript JSON parsers
      json_output = JSON.generate(result)
      json_output = json_output.gsub("\u2028", "\\u2028").gsub("\u2029", "\\u2029")
      puts json_output
      $stdout.flush

      break if command["type"] == "shutdown"
    rescue JSON::ParserError => e
      puts JSON.generate({
                           "type" => "error",
                           "success" => false,
                           "commandType" => "init",
                           "errorCode" => ErrorCode::PARSE_ERROR,
                           "message" => "Failed to parse command: #{e.message}"
                         })
      $stdout.flush
    end
  end
end

main if __FILE__ == $PROGRAM_NAME
