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
ERROR_CODES = {
  "NETWORK_ERROR" => "NETWORK_ERROR",
  "TIMEOUT" => "TIMEOUT",
  "CONFLICT" => "CONFLICT",
  "NOT_FOUND" => "NOT_FOUND",
  "SEQUENCE_CONFLICT" => "SEQUENCE_CONFLICT",
  "INVALID_OFFSET" => "INVALID_OFFSET",
  "UNEXPECTED_STATUS" => "UNEXPECTED_STATUS",
  "PARSE_ERROR" => "PARSE_ERROR",
  "INTERNAL_ERROR" => "INTERNAL_ERROR",
  "NOT_SUPPORTED" => "NOT_SUPPORTED"
}.freeze

# Global state
$server_url = ""
$stream_content_types = {}

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

def resolve_dynamic_headers
  headers = {}
  values = {}

  $dynamic_headers.each do |name, config|
    value = config.get_value
    values[name] = value
    headers[name] = value
  end

  [headers, values]
end

def resolve_dynamic_params
  params = {}
  values = {}

  $dynamic_params.each do |name, config|
    value = config.get_value
    values[name] = value
    params[name] = value
  end

  [params, values]
end

def map_error_code(err)
  case err
  when DurableStreams::ParseError
    [ERROR_CODES["PARSE_ERROR"], nil]
  when DurableStreams::StreamNotFoundError
    [ERROR_CODES["NOT_FOUND"], 404]
  when DurableStreams::StreamExistsError
    [ERROR_CODES["CONFLICT"], 409]
  when DurableStreams::SeqConflictError
    [ERROR_CODES["SEQUENCE_CONFLICT"], 409]
  when DurableStreams::BadRequestError
    [ERROR_CODES["INVALID_OFFSET"], 400]
  when DurableStreams::TimeoutError
    [ERROR_CODES["TIMEOUT"], nil]
  when DurableStreams::ConnectionError
    [ERROR_CODES["NETWORK_ERROR"], nil]
  when DurableStreams::FetchError
    status = err.status
    case status
    when 404 then [ERROR_CODES["NOT_FOUND"], 404]
    when 409 then [ERROR_CODES["CONFLICT"], 409]
    else [ERROR_CODES["UNEXPECTED_STATUS"], status]
    end
  when DurableStreams::Error
    status = err.status
    [ERROR_CODES["UNEXPECTED_STATUS"], status]
  else
    [ERROR_CODES["INTERNAL_ERROR"], nil]
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
      "dynamicHeaders" => true
    }
  }
end

def handle_create(cmd)
  url = "#{$server_url}#{cmd["path"]}"
  content_type = cmd["contentType"] || "application/octet-stream"

  # Check if stream already exists
  already_exists = false
  begin
    stream = DurableStreams::Stream.new(url: url)
    stream.head
    already_exists = true
  rescue DurableStreams::StreamNotFoundError
    # Expected - stream doesn't exist yet
  end

  # Create the stream
  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.create(
    url: url,
    content_type: content_type,
    ttl_seconds: cmd["ttlSeconds"],
    expires_at: cmd["expiresAt"],
    headers: headers
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
  stream = DurableStreams::Stream.connect(url: url, headers: headers)

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
    url: url,
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

  stream = DurableStreams::Stream.new(
    url: url,
    content_type: content_type,
    headers: merged_headers
  )

  begin
    if live == false
      # Catch-up mode
      reader = is_json ? stream.read_json(offset: offset, live: false) : stream.read_bytes(offset: offset, live: false)

      if is_json
        reader.each_batch do |batch|
          data = JSON.generate(batch.items)
          chunks << { "data" => data, "offset" => batch.next_offset } unless batch.items.empty?
          final_offset = batch.next_offset
          up_to_date = batch.up_to_date
        end
      else
        reader.each do |chunk|
          chunks << { "data" => chunk.data, "offset" => chunk.next_offset } unless chunk.data.empty?
          final_offset = chunk.next_offset
          up_to_date = chunk.up_to_date
        end
      end
      status = reader.status || 200
      reader.close
    elsif live == :sse
      # SSE mode with timeout
      reader = stream.read_json(offset: offset, live: :sse)
      chunk_count = 0

      begin
        Timeout.timeout(timeout_ms / 1000.0) do
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
        end
      rescue Timeout::Error
        # Timeout is expected for SSE when waiting for data
        up_to_date = true
      end

      status = reader.status || 200
      reader.close
    else
      # Long-poll mode
      reader = is_json ? stream.read_json(offset: offset, live: :long_poll) : stream.read_bytes(offset: offset, live: :long_poll)
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
              chunks << { "data" => chunk.data, "offset" => chunk.next_offset }
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

  result = {
    "type" => "read",
    "success" => true,
    "status" => status,
    "chunks" => chunks,
    "offset" => final_offset,
    "upToDate" => up_to_date
  }
  result["headersSent"] = headers_sent unless headers_sent.empty?
  result["paramsSent"] = params_sent unless params_sent.empty?
  result
end

def handle_head(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.new(url: url, headers: headers)
  result = stream.head

  # Cache content type
  $stream_content_types[cmd["path"]] = result.content_type if result.content_type

  {
    "type" => "head",
    "success" => true,
    "status" => 200,
    "offset" => result.next_offset,
    "contentType" => result.content_type
  }
end

def handle_delete(cmd)
  url = "#{$server_url}#{cmd["path"]}"

  headers = cmd["headers"] || {}
  stream = DurableStreams::Stream.new(url: url, headers: headers)
  stream.delete

  # Remove from cache
  $stream_content_types.delete(cmd["path"])

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

      stream = DurableStreams::Stream.new(url: url, content_type: content_type, batching: false)
      payload = "*" * operation["size"]
      stream.append(payload)
      metrics["bytesTransferred"] = operation["size"]

    when "read"
      url = "#{$server_url}#{operation["path"]}"
      offset = operation["offset"]

      stream = DurableStreams::Stream.new(url: url)
      reader = stream.read_bytes(offset: offset, live: false)
      data = reader.body
      reader.close
      metrics["bytesTransferred"] = data.bytesize

    when "create"
      url = "#{$server_url}#{operation["path"]}"
      content_type = operation["contentType"] || "application/octet-stream"
      DurableStreams::Stream.create(url: url, content_type: content_type)

    when "throughput_append"
      url = "#{$server_url}#{operation["path"]}"
      content_type = $stream_content_types[operation["path"]] || "application/octet-stream"

      # Ensure stream exists
      begin
        DurableStreams::Stream.create(url: url, content_type: content_type)
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
          stream = DurableStreams::Stream.new(url: url, content_type: content_type, batching: true)
          thread_count.times { stream.append(payload) }
        end
      end

      threads.each(&:join)

      metrics["bytesTransferred"] = count * operation["size"]
      metrics["messagesProcessed"] = count

    when "throughput_read"
      url = "#{$server_url}#{operation["path"]}"

      stream = DurableStreams::Stream.new(url: url)
      reader = stream.read_json(offset: "-1", live: false)

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

      stream = DurableStreams::Stream.create(url: url, content_type: content_type)

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
          if is_json
            reader = stream.read_json(offset: "-1", live: live_sym)
            reader.each do |item|
              read_data = item
              break
            end
            reader.close
          else
            reader = stream.read_bytes(offset: "-1", live: live_sym)
            reader.each do |chunk|
              read_data = chunk.data
              break
            end
            reader.close
          end
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
        "errorCode" => ERROR_CODES["NOT_SUPPORTED"],
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
      "errorCode" => ERROR_CODES["INTERNAL_ERROR"],
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
  data = cmd["data"]

  # For JSON streams, parse the string data
  is_json = DurableStreams.json_content_type?(content_type)
  data = JSON.parse(data) if is_json && data.is_a?(String)

  producer = DurableStreams::Producer.new(
    url: url,
    producer_id: producer_id,
    epoch: epoch,
    auto_claim: auto_claim,
    max_in_flight: 1,
    linger_ms: 0,
    content_type: content_type
  )

  producer.append(data)
  producer.flush
  producer.close

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
  items = cmd["items"]
  max_in_flight = cmd["maxInFlight"] || 1

  # For JSON streams, parse string items
  is_json = DurableStreams.json_content_type?(content_type)
  items = items.map { |item| is_json && item.is_a?(String) ? JSON.parse(item) : item }

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

def handle_validate(cmd)
  target = cmd["target"]
  target_type = target["target"]

  case target_type
  when "idempotent-producer"
    epoch = target["epoch"] || 0
    max_batch_bytes = target["maxBatchBytes"] || 1_048_576

    if epoch < 0
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "epoch must be non-negative, got: #{epoch}"
      }
    end

    if max_batch_bytes < 1
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "maxBatchBytes must be positive, got: #{max_batch_bytes}"
      }
    end

    {
      "type" => "validate",
      "success" => true
    }

  when "retry-options"
    max_retries = target["maxRetries"] || 3
    initial_delay_ms = target["initialDelayMs"] || 100
    max_delay_ms = target["maxDelayMs"] || 5000
    multiplier = target["multiplier"] || 2.0

    if max_retries < 0
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "maxRetries must be non-negative, got: #{max_retries}"
      }
    end

    if initial_delay_ms < 1
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "initialDelayMs must be positive, got: #{initial_delay_ms}"
      }
    end

    if max_delay_ms < 1
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "maxDelayMs must be positive, got: #{max_delay_ms}"
      }
    end

    if multiplier < 1.0
      return {
        "type" => "error",
        "success" => false,
        "commandType" => "validate",
        "errorCode" => "INVALID_ARGUMENT",
        "message" => "multiplier must be >= 1.0, got: #{multiplier}"
      }
    end

    {
      "type" => "validate",
      "success" => true
    }

  else
    {
      "type" => "error",
      "success" => false,
      "commandType" => "validate",
      "errorCode" => ERROR_CODES["NOT_SUPPORTED"],
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
    when "delete" then handle_delete(cmd)
    when "shutdown" then handle_shutdown(cmd)
    when "benchmark" then handle_benchmark(cmd)
    when "set-dynamic-header" then handle_set_dynamic_header(cmd)
    when "set-dynamic-param" then handle_set_dynamic_param(cmd)
    when "clear-dynamic" then handle_clear_dynamic(cmd)
    when "idempotent-append" then handle_idempotent_append(cmd)
    when "idempotent-append-batch" then handle_idempotent_append_batch(cmd)
    when "validate" then handle_validate(cmd)
    else
      {
        "type" => "error",
        "success" => false,
        "commandType" => cmd_type,
        "errorCode" => ERROR_CODES["NOT_SUPPORTED"],
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
      puts JSON.generate(result)
      $stdout.flush

      break if command["type"] == "shutdown"
    rescue JSON::ParserError => e
      puts JSON.generate({
                           "type" => "error",
                           "success" => false,
                           "commandType" => "init",
                           "errorCode" => ERROR_CODES["PARSE_ERROR"],
                           "message" => "Failed to parse command: #{e.message}"
                         })
      $stdout.flush
    end
  end
end

main if __FILE__ == $PROGRAM_NAME
