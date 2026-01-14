using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DurableStreams;

// JSON serialization options
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    WriteIndented = false
};

// State
DurableStreamClient? client = null;
var streamContentTypes = new Dictionary<string, string>();
var dynamicHeaders = new Dictionary<string, Func<string>>();
var dynamicParams = new Dictionary<string, Func<string>>();
var dynamicCounters = new Dictionary<string, int>();

// Main loop - read JSON commands from stdin, write results to stdout
using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
using var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

string? line;
while ((line = await reader.ReadLineAsync()) != null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    try
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var type = root.GetProperty("type").GetString();

        var result = type switch
        {
            "init" => await HandleInit(root),
            "create" => await HandleCreate(root),
            "connect" => await HandleConnect(root),
            "append" => await HandleAppend(root),
            "read" => await HandleRead(root),
            "head" => await HandleHead(root),
            "delete" => await HandleDelete(root),
            "idempotent-append" => await HandleIdempotentAppend(root),
            "idempotent-append-batch" => await HandleIdempotentAppendBatch(root),
            "validate" => HandleValidate(root),
            "set-dynamic-header" => HandleSetDynamicHeader(root),
            "set-dynamic-param" => HandleSetDynamicParam(root),
            "clear-dynamic" => HandleClearDynamic(),
            "benchmark" => await HandleBenchmark(root),
            "shutdown" => HandleShutdown(),
            _ => CreateError(type ?? "unknown", "NOT_SUPPORTED", $"Unknown command type: {type}")
        };

        writer.WriteLine(JsonSerializer.Serialize(result, jsonOptions));

        if (type == "shutdown")
        {
            break;
        }
    }
    catch (Exception ex)
    {
        var error = CreateError("unknown", "INTERNAL_ERROR", ex.Message);
        writer.WriteLine(JsonSerializer.Serialize(error, jsonOptions));
    }
}

// Handlers
async Task<object> HandleInit(JsonElement root)
{
    var serverUrl = root.GetProperty("serverUrl").GetString()!;

    // When running in Docker on macOS, localhost/127.0.0.1 URLs need to be rewritten
    // to host.docker.internal to reach the host machine
    var dockerHost = Environment.GetEnvironmentVariable("DOCKER_HOST_OVERRIDE");
    if (!string.IsNullOrEmpty(dockerHost))
    {
        serverUrl = serverUrl
            .Replace("localhost", dockerHost)
            .Replace("127.0.0.1", dockerHost);
    }

    client = new DurableStreamClient(new DurableStreamClientOptions
    {
        BaseUrl = serverUrl,
        MaxRetries = 3,
        InitialRetryDelay = TimeSpan.FromMilliseconds(100)
    });

    return new
    {
        type = "init",
        success = true,
        clientName = "durable-streams-dotnet",
        clientVersion = "0.0.1",
        features = new
        {
            batching = true,
            sse = true,
            longPoll = true,
            streaming = true,
            dynamicHeaders = true
        }
    };
}

async Task<object> HandleCreate(JsonElement root)
{
    if (client == null) return CreateError("create", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var contentType = GetOptionalString(root, "contentType");
    var ttlSeconds = GetOptionalInt(root, "ttlSeconds");
    var expiresAt = GetOptionalString(root, "expiresAt");
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);
        var result = await stream.CreateAsync(new CreateStreamOptions
        {
            ContentType = contentType,
            Ttl = ttlSeconds.HasValue ? TimeSpan.FromSeconds(ttlSeconds.Value) : null,
            ExpiresAt = expiresAt != null ? DateTimeOffset.Parse(expiresAt) : null,
            Headers = headers
        });
        var statusCode = result == CreateStreamResult.Created ? 201 : 200;

        if (contentType != null)
        {
            streamContentTypes[path] = contentType;
        }

        var metadata = await stream.HeadAsync();

        return new
        {
            type = "create",
            success = true,
            status = statusCode,
            offset = metadata.Offset?.ToString(),
            headers = new Dictionary<string, string?>
            {
                ["content-type"] = metadata.ContentType,
                ["stream-next-offset"] = metadata.Offset?.ToString()
            }
        };
    }
    catch (DurableStreamException ex) when (ex.Code == DurableStreamErrorCode.ConflictExists)
    {
        return new { type = "create", success = true, status = 409 };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("create", ex);
    }
}

async Task<object> HandleConnect(JsonElement root)
{
    if (client == null) return CreateError("connect", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);
        var metadata = await stream.HeadAsync();

        if (metadata.ContentType != null)
        {
            streamContentTypes[path] = metadata.ContentType;
        }

        return new
        {
            type = "connect",
            success = true,
            status = 200,
            headers = new Dictionary<string, string?>
            {
                ["content-type"] = metadata.ContentType
            }
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("connect", ex);
    }
}

async Task<object> HandleAppend(JsonElement root)
{
    if (client == null) return CreateError("append", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var data = root.GetProperty("data").GetString()!;
    var binary = GetOptionalBool(root, "binary");
    var seq = GetOptionalStringOrNumber(root, "seq");
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);

        // Set content type from cache
        if (streamContentTypes.TryGetValue(path, out var ct))
        {
            stream.ContentType = ct;
        }

        byte[] bytes;
        if (binary == true)
        {
            bytes = Convert.FromBase64String(data);
        }
        else
        {
            bytes = Encoding.UTF8.GetBytes(data);
        }

        // Track dynamic values sent
        var headersSent = ApplyDynamicHeaders(headers);
        var paramsSent = ApplyDynamicParams(null);

        var result = await stream.AppendAsync(bytes, new AppendOptions
        {
            Seq = seq,
            Headers = headersSent
        });

        return new
        {
            type = "append",
            success = true,
            status = 200,
            offset = result.NextOffset?.ToString(),
            headersSent,
            paramsSent
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("append", ex);
    }
}

async Task<object> HandleRead(JsonElement root)
{
    if (client == null) return CreateError("read", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var offset = GetOptionalString(root, "offset");
    var liveStr = GetOptionalString(root, "live");
    var timeoutMs = GetOptionalInt(root, "timeoutMs");
    var maxChunks = GetOptionalInt(root, "maxChunks") ?? 100;
    var waitForUpToDate = GetOptionalBool(root, "waitForUpToDate") ?? false;
    var headers = GetHeaders(root);

    var live = liveStr switch
    {
        "long-poll" => LiveMode.LongPoll,
        "sse" => LiveMode.Sse,
        _ => LiveMode.Off
    };

    try
    {
        var stream = client.GetStream(path);

        // Set content type from cache
        if (streamContentTypes.TryGetValue(path, out var ct))
        {
            stream.ContentType = ct;
        }

        var headersSent = ApplyDynamicHeaders(headers);
        var paramsSent = ApplyDynamicParams(null);

        using var cts = timeoutMs.HasValue
            ? new CancellationTokenSource(timeoutMs.Value)
            : new CancellationTokenSource(TimeSpan.FromSeconds(30));

        await using var response = await stream.StreamAsync(new StreamOptions
        {
            Offset = offset != null ? new Offset(offset) : Offset.Beginning,
            Live = live,
            Headers = headersSent
        }, cts.Token);

        var chunks = new List<object>();
        var chunkCount = 0;
        // Use response's initial offset as default (important for offset=now)
        string? finalOffset = response.Offset.ToString();
        bool upToDate = response.UpToDate;
        string? cursor = null;
        bool timedOut = false;

        // Determine if we should use JSON parsing based on content type
        // Check both the cache and the response's content type header
        var cachedContentType = streamContentTypes.GetValueOrDefault(path);
        var responseContentType = response.ContentType;
        var effectiveContentType = responseContentType ?? cachedContentType;
        var isJson = effectiveContentType?.Contains("application/json") == true;

        try
        {
            await foreach (var chunk in response.ReadBytesAsync(cts.Token))
            {
                finalOffset = chunk.Checkpoint.Offset.ToString();
                upToDate = chunk.UpToDate;
                cursor = chunk.Checkpoint.Cursor;

                // Only add chunks with data (matches Go behavior)
                if (chunk.Data.Length > 0)
                {
                    var chunkData = Encoding.UTF8.GetString(chunk.Data.Span);

                    // For JSON content, validate the JSON to trigger PARSE_ERROR on malformed data
                    if (isJson)
                    {
                        try
                        {
                            using var doc = System.Text.Json.JsonDocument.Parse(chunkData);
                        }
                        catch (Exception ex)
                        {
                            // Catch any parsing exception (JsonException, ArgumentException, etc.)
                            throw new DurableStreamException(
                                $"Failed to parse JSON response: {ex.Message}. Data: {(chunkData.Length > 100 ? chunkData[..100] + "..." : chunkData)}",
                                DurableStreamErrorCode.ParseError,
                                null,
                                null);
                        }
                    }

                    chunks.Add(new
                    {
                        data = chunkData,
                        offset = chunk.Checkpoint.Offset.ToString()
                    });
                    chunkCount++;
                }

                if (chunkCount >= maxChunks) break;
                if (upToDate && !waitForUpToDate && live == LiveMode.Off) break;
                if (upToDate && waitForUpToDate) break;
            }
        }
        catch (OperationCanceledException)
        {
            // Timeout is ok for long-poll - timeout means we're up-to-date
            finalOffset = response.Offset.ToString();
            upToDate = true;  // Timeout = caught up with stream
            timedOut = true;
        }

        // Return 204 for long-poll timeout with no data
        var status = (live == LiveMode.LongPoll && timedOut && chunks.Count == 0) ? 204 : 200;

        return new
        {
            type = "read",
            success = true,
            status,
            chunks,
            offset = finalOffset,
            upToDate,
            cursor,
            headersSent,
            paramsSent
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("read", ex);
    }
}

async Task<object> HandleHead(JsonElement root)
{
    if (client == null) return CreateError("head", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);
        var metadata = await stream.HeadAsync();

        if (metadata.ContentType != null)
        {
            streamContentTypes[path] = metadata.ContentType;
        }

        return new
        {
            type = "head",
            success = true,
            status = 200,
            offset = metadata.Offset?.ToString(),
            contentType = metadata.ContentType,
            ttlSeconds = metadata.Ttl.HasValue ? (int?)metadata.Ttl.Value.TotalSeconds : null,
            expiresAt = metadata.ExpiresAt?.ToString("o")
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("head", ex);
    }
}

async Task<object> HandleDelete(JsonElement root)
{
    if (client == null) return CreateError("delete", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);
        await stream.DeleteAsync();

        streamContentTypes.Remove(path);

        return new { type = "delete", success = true, status = 200 };
    }
    catch (StreamNotFoundException)
    {
        return new
        {
            type = "error",
            success = false,
            commandType = "delete",
            errorCode = "NOT_FOUND",
            status = 404,
            message = "Stream not found"
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("delete", ex);
    }
}

async Task<object> HandleIdempotentAppend(JsonElement root)
{
    if (client == null) return CreateError("idempotent-append", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var data = root.GetProperty("data").GetString()!;
    var producerId = root.GetProperty("producerId").GetString()!;
    var epoch = root.GetProperty("epoch").GetInt32();
    var autoClaim = root.GetProperty("autoClaim").GetBoolean();
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);

        // Set content type from cache
        if (streamContentTypes.TryGetValue(path, out var ct))
        {
            stream.ContentType = ct;
        }

        var producer = stream.CreateProducer(producerId, new IdempotentProducerOptions
        {
            Epoch = epoch,
            AutoClaim = autoClaim,
            MaxInFlight = 1, // Sequential for single append
            Linger = TimeSpan.Zero
        });

        await using (producer)
        {
            if (stream.ContentType == "application/json")
            {
                // Parse and append as JSON
                using var doc = JsonDocument.Parse(data);
                producer.Append(doc.RootElement);
            }
            else
            {
                producer.Append(data);
            }

            await producer.FlushAsync();
        }

        return new
        {
            type = "idempotent-append",
            success = true,
            status = 200,
            producerEpoch = producer.Epoch,
            producerSeq = producer.NextSeq - 1
        };
    }
    catch (StaleEpochException ex)
    {
        return new
        {
            type = "idempotent-append",
            success = true,
            status = 403,
            producerEpoch = ex.CurrentEpoch
        };
    }
    catch (SequenceGapException ex)
    {
        return new
        {
            type = "idempotent-append",
            success = true,
            status = 409,
            producerExpectedSeq = ex.ExpectedSeq,
            producerReceivedSeq = ex.ReceivedSeq
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("idempotent-append", ex);
    }
}

async Task<object> HandleIdempotentAppendBatch(JsonElement root)
{
    if (client == null) return CreateError("idempotent-append-batch", "INTERNAL_ERROR", "Client not initialized");

    var path = root.GetProperty("path").GetString()!;
    var items = root.GetProperty("items");
    var producerId = root.GetProperty("producerId").GetString()!;
    var epoch = root.GetProperty("epoch").GetInt32();
    var autoClaim = root.GetProperty("autoClaim").GetBoolean();
    var maxInFlight = GetOptionalInt(root, "maxInFlight") ?? 1;
    var headers = GetHeaders(root);

    try
    {
        var stream = client.GetStream(path);

        // Set content type from cache
        if (streamContentTypes.TryGetValue(path, out var ct))
        {
            stream.ContentType = ct;
        }

        var producer = stream.CreateProducer(producerId, new IdempotentProducerOptions
        {
            Epoch = epoch,
            AutoClaim = autoClaim,
            MaxInFlight = maxInFlight,
            Linger = TimeSpan.Zero
        });

        Exception? lastError = null;
        producer.OnError += (_, e) => lastError = e.Exception;

        await using (producer)
        {
            foreach (var item in items.EnumerateArray())
            {
                var data = item.GetString()!;
                if (stream.ContentType == "application/json")
                {
                    using var doc = JsonDocument.Parse(data);
                    producer.Append(doc.RootElement);
                }
                else
                {
                    producer.Append(data);
                }
            }

            await producer.FlushAsync();
        }

        if (lastError != null)
        {
            throw lastError;
        }

        return new
        {
            type = "idempotent-append-batch",
            success = true,
            status = 200,
            producerEpoch = producer.Epoch,
            producerSeq = producer.NextSeq - 1
        };
    }
    catch (StaleEpochException ex)
    {
        return new
        {
            type = "idempotent-append-batch",
            success = true,
            status = 403,
            producerEpoch = ex.CurrentEpoch
        };
    }
    catch (SequenceGapException ex)
    {
        return new
        {
            type = "idempotent-append-batch",
            success = true,
            status = 409,
            producerExpectedSeq = ex.ExpectedSeq,
            producerReceivedSeq = ex.ReceivedSeq
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("idempotent-append-batch", ex);
    }
}

object HandleSetDynamicHeader(JsonElement root)
{
    var name = root.GetProperty("name").GetString()!;
    var valueType = root.GetProperty("valueType").GetString()!;
    var initialValue = GetOptionalString(root, "initialValue");

    switch (valueType)
    {
        case "counter":
            var counterKey = $"header:{name}";
            dynamicCounters[counterKey] = 0;
            dynamicHeaders[name] = () =>
            {
                // Pre-increment: first call returns 1, second returns 2, etc.
                var value = ++dynamicCounters[counterKey];
                return value.ToString();
            };
            break;

        case "timestamp":
            dynamicHeaders[name] = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
            break;

        case "token":
            dynamicHeaders[name] = () => initialValue ?? "";
            break;
    }

    return new { type = "set-dynamic-header", success = true };
}

object HandleSetDynamicParam(JsonElement root)
{
    var name = root.GetProperty("name").GetString()!;
    var valueType = root.GetProperty("valueType").GetString()!;

    switch (valueType)
    {
        case "counter":
            var counterKey = $"param:{name}";
            dynamicCounters[counterKey] = 0;
            dynamicParams[name] = () =>
            {
                // Pre-increment: first call returns 1, second returns 2, etc.
                var value = ++dynamicCounters[counterKey];
                return value.ToString();
            };
            break;

        case "timestamp":
            dynamicParams[name] = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
            break;
    }

    return new { type = "set-dynamic-param", success = true };
}

object HandleClearDynamic()
{
    dynamicHeaders.Clear();
    dynamicParams.Clear();
    dynamicCounters.Clear();

    return new { type = "clear-dynamic", success = true };
}

object HandleValidate(JsonElement root)
{
    if (!root.TryGetProperty("target", out var target))
    {
        return CreateError("validate", "PARSE_ERROR", "missing target");
    }

    var targetType = target.GetProperty("target").GetString();

    switch (targetType)
    {
        case "retry-options":
            // C# client doesn't have a separate RetryOptions class with validation
            return CreateError("validate", "NOT_SUPPORTED", "C# client does not have RetryOptions class");

        case "idempotent-producer":
            try
            {
                var producerId = target.TryGetProperty("producerId", out var pidProp)
                    ? pidProp.GetString() ?? "test-producer"
                    : "test-producer";

                var options = new IdempotentProducerOptions();

                if (target.TryGetProperty("epoch", out var epochProp))
                {
                    options.Epoch = epochProp.GetInt32();
                }

                if (target.TryGetProperty("maxBatchBytes", out var maxBatchBytesProp))
                {
                    options.MaxBatchBytes = maxBatchBytesProp.GetInt32();
                }

                // Try to create a producer - this will validate the options
                var stream = client!.GetStream("/test-validate");
                _ = stream.CreateProducer(producerId, options);

                return new { type = "validate", success = true };
            }
            catch (ArgumentOutOfRangeException ex)
            {
                return new
                {
                    type = "error",
                    success = false,
                    commandType = "validate",
                    errorCode = "INVALID_ARGUMENT",
                    message = ex.Message
                };
            }
            catch (ArgumentException ex)
            {
                return new
                {
                    type = "error",
                    success = false,
                    commandType = "validate",
                    errorCode = "INVALID_ARGUMENT",
                    message = ex.Message
                };
            }

        default:
            return CreateError("validate", "NOT_SUPPORTED", $"Unknown validation target: {targetType}");
    }
}

async Task<object> HandleBenchmark(JsonElement root)
{
    var iterationId = root.GetProperty("iterationId").GetString()!;
    var operation = root.GetProperty("operation");
    var op = operation.GetProperty("op").GetString()!;

    var stopwatch = Stopwatch.StartNew();

    try
    {
        object? metrics = null;

        switch (op)
        {
            case "append":
                await BenchmarkAppend(operation);
                break;
            case "read":
                await BenchmarkRead(operation);
                break;
            case "create":
                await BenchmarkCreate(operation);
                break;
            case "roundtrip":
                await BenchmarkRoundtrip(operation);
                break;
            case "throughput_append":
                metrics = await BenchmarkThroughputAppend(operation);
                break;
            case "throughput_read":
                metrics = await BenchmarkThroughputRead(operation);
                break;
            default:
                return CreateError("benchmark", "NOT_SUPPORTED", $"Unknown benchmark op: {op}");
        }

        stopwatch.Stop();

        if (metrics != null)
        {
            return new
            {
                type = "benchmark",
                success = true,
                iterationId,
                durationNs = (stopwatch.ElapsedTicks * 1_000_000_000L / Stopwatch.Frequency).ToString(),
                metrics
            };
        }

        return new
        {
            type = "benchmark",
            success = true,
            iterationId,
            durationNs = (stopwatch.ElapsedTicks * 1_000_000_000L / Stopwatch.Frequency).ToString()
        };
    }
    catch (Exception ex)
    {
        return CreateErrorFromException("benchmark", ex);
    }
}

async Task BenchmarkAppend(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;
    var size = op.GetProperty("size").GetInt32();

    var data = new byte[size];
    Random.Shared.NextBytes(data);

    var stream = client!.GetStream(path);
    if (streamContentTypes.TryGetValue(path, out var ct))
    {
        stream.ContentType = ct;
    }

    await stream.AppendAsync(data);
}

async Task BenchmarkRead(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;
    var offset = GetOptionalString(op, "offset");

    var stream = client!.GetStream(path);
    await using var response = await stream.StreamAsync(new StreamOptions
    {
        Offset = offset != null ? new Offset(offset) : Offset.Beginning
    });

    await response.ReadAllBytesAsync();
}

async Task BenchmarkCreate(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;
    var contentType = GetOptionalString(op, "contentType") ?? "application/octet-stream";

    var stream = client!.GetStream(path);
    await stream.CreateAsync(new CreateStreamOptions { ContentType = contentType });
    streamContentTypes[path] = contentType;
}

async Task BenchmarkRoundtrip(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;
    var size = op.GetProperty("size").GetInt32();
    var liveStr = GetOptionalString(op, "live");
    var contentType = GetOptionalString(op, "contentType") ?? "application/octet-stream";

    // Generate appropriate data based on content type
    byte[] data;
    if (contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
    {
        // For JSON content type, generate valid JSON
        var payload = new { message = new string('x', Math.Max(0, size - 20)) };
        data = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(payload);
    }
    else
    {
        data = new byte[size];
        Array.Fill(data, (byte)42); // Use fill for speed like Go adapter
    }

    var live = liveStr switch
    {
        "long-poll" => LiveMode.LongPoll,
        "sse" => LiveMode.Sse,
        _ => LiveMode.LongPoll
    };

    var stream = client!.GetStream(path);
    stream.ContentType = contentType;

    // Create stream first (append doesn't auto-create)
    try
    {
        await stream.CreateAsync(new CreateStreamOptions { ContentType = contentType });
    }
    catch (DurableStreamException)
    {
        // Stream may already exist, that's ok
    }

    // Append data
    var result = await stream.AppendAsync(data);

    // Calculate offset before our append
    var prevOffset = "-1";
    var nextOffsetStr = result.NextOffset?.ToString() ?? "0";
    if (int.TryParse(nextOffsetStr, out var nextOffsetInt))
    {
        prevOffset = (nextOffsetInt - data.Length).ToString();
    }

    // Read back from that offset with live mode
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    await using var response = await stream.StreamAsync(new StreamOptions
    {
        Offset = new Offset(prevOffset),
        Live = live
    }, cts.Token);

    // Wait for first chunk with data
    await foreach (var chunk in response.ReadBytesAsync(cts.Token))
    {
        if (chunk.Data.Length > 0) break;
    }
}

async Task<object> BenchmarkThroughputAppend(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;
    var count = op.GetProperty("count").GetInt32();
    var size = op.GetProperty("size").GetInt32();
    var concurrency = GetOptionalInt(op, "concurrency") ?? 10;

    var ct = streamContentTypes.GetValueOrDefault(path, "application/octet-stream");

    // Use IdempotentProducer for automatic batching and pipelining
    var stream = client!.GetStream(path);
    stream.ContentType = ct;
    await using var producer = stream.CreateProducer("bench-producer", new IdempotentProducerOptions
    {
        Linger = TimeSpan.Zero, // Batch by size, not time (matches Go)
        ContentType = ct,
        MaxInFlight = 5 // Match Go default
    });

    // Pre-generate payload (reuse same data for speed)
    var payload = new byte[size];
    Random.Shared.NextBytes(payload);

    var start = Stopwatch.GetTimestamp();

    // Fire-and-forget: Append returns immediately, producer batches in background
    for (var i = 0; i < count; i++)
    {
        producer.Append(payload);
    }

    // Wait for all batches to complete with timeout
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(55));
    await producer.FlushAsync(cts.Token);

    var elapsed = Stopwatch.GetElapsedTime(start);
    var totalBytes = count * size;
    var opsPerSec = count / elapsed.TotalSeconds;
    var bytesPerSec = totalBytes / elapsed.TotalSeconds;

    return new
    {
        bytesTransferred = totalBytes,
        messagesProcessed = count,
        opsPerSecond = opsPerSec,
        bytesPerSecond = bytesPerSec
    };
}

async Task<object> BenchmarkThroughputRead(JsonElement op)
{
    var path = op.GetProperty("path").GetString()!;

    var stream = client!.GetStream(path);
    stream.ContentType = "application/json";

    var start = Stopwatch.GetTimestamp();

    var totalBytes = 0;
    var count = 0;

    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(55));
    await using var response = await stream.StreamAsync(new StreamOptions
    {
        Offset = Offset.Beginning
    }, cts.Token);

    await foreach (var batch in response.ReadJsonBatchesAsync<Dictionary<string, object>>(cts.Token))
    {
        foreach (var item in batch.Items)
        {
            count++;
            // Rough byte estimate
            var json = System.Text.Json.JsonSerializer.Serialize(item);
            totalBytes += json.Length;
        }
        if (batch.UpToDate) break;
    }

    var elapsed = Stopwatch.GetElapsedTime(start);
    var bytesPerSec = totalBytes / elapsed.TotalSeconds;

    return new
    {
        bytesTransferred = totalBytes,
        messagesProcessed = count,
        bytesPerSecond = bytesPerSec
    };
}

object HandleShutdown()
{
    client?.Dispose();
    return new { type = "shutdown", success = true };
}

// Helper functions
string? GetOptionalString(JsonElement root, string name)
{
    return root.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String
        ? prop.GetString()
        : null;
}

string? GetOptionalStringOrNumber(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var prop)) return null;
    return prop.ValueKind switch
    {
        JsonValueKind.String => prop.GetString(),
        JsonValueKind.Number => prop.GetRawText(),
        _ => null
    };
}

int? GetOptionalInt(JsonElement root, string name)
{
    return root.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.Number
        ? prop.GetInt32()
        : null;
}

bool? GetOptionalBool(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var prop)) return null;
    return prop.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null
    };
}

Dictionary<string, string>? GetHeaders(JsonElement root)
{
    if (!root.TryGetProperty("headers", out var headers)) return null;
    if (headers.ValueKind != JsonValueKind.Object) return null;

    var result = new Dictionary<string, string>();
    foreach (var prop in headers.EnumerateObject())
    {
        result[prop.Name] = prop.Value.GetString() ?? "";
    }
    return result;
}

Dictionary<string, string> ApplyDynamicHeaders(Dictionary<string, string>? staticHeaders)
{
    var result = new Dictionary<string, string>();

    if (staticHeaders != null)
    {
        foreach (var (k, v) in staticHeaders)
        {
            result[k] = v;
        }
    }

    foreach (var (name, factory) in dynamicHeaders)
    {
        result[name] = factory();
    }

    return result;
}

Dictionary<string, string> ApplyDynamicParams(Dictionary<string, string>? staticParams)
{
    var result = new Dictionary<string, string>();

    if (staticParams != null)
    {
        foreach (var (k, v) in staticParams)
        {
            result[k] = v;
        }
    }

    foreach (var (name, factory) in dynamicParams)
    {
        result[name] = factory();
    }

    return result;
}

object CreateError(string commandType, string errorCode, string message)
{
    return new
    {
        type = "error",
        success = false,
        commandType,
        errorCode,
        message
    };
}

object CreateErrorFromException(string commandType, Exception ex)
{
    var (errorCode, status) = ex switch
    {
        StreamNotFoundException => ("NOT_FOUND", 404),
        StaleEpochException => ("FORBIDDEN", 403),
        SequenceGapException => ("SEQUENCE_CONFLICT", 409),
        DurableStreamException dse => (MapErrorCode(dse), dse.StatusCode ?? 500),
        InvalidOperationException when ex.Message.Contains("SSE") || ex.Message.Contains("JSON") => ("PARSE_ERROR", null as int?),
        OperationCanceledException => ("TIMEOUT", null as int?),
        HttpRequestException => ("NETWORK_ERROR", null),
        _ => ("INTERNAL_ERROR", null as int?)
    };

    string MapErrorCode(DurableStreamException dse)
    {
        // Map error codes to conformance test expected values
        return dse.Code switch
        {
            DurableStreamErrorCode.ParseError => "PARSE_ERROR",
            DurableStreamErrorCode.BadRequest when commandType == "read" ||
                dse.Message.ToLowerInvariant().Contains("offset") => "INVALID_OFFSET",
            DurableStreamErrorCode.ConflictSeq => "SEQUENCE_CONFLICT",
            DurableStreamErrorCode.ConflictExists => "CONFLICT",
            _ => dse.Code.ToString().ToUpperInvariant()
        };
    }

    var result = new Dictionary<string, object?>
    {
        ["type"] = "error",
        ["success"] = false,
        ["commandType"] = commandType,
        ["errorCode"] = errorCode,
        ["message"] = ex.Message
    };

    if (status.HasValue)
    {
        result["status"] = status.Value;
    }

    return result;
}
