//! Conformance test adapter for the Rust client.
//!
//! Communicates with the test runner via stdin/stdout using a JSON-line protocol.

use bytes::Bytes;
use durable_streams::{
    AppendOptions, Client, CreateOptions, LiveMode, Offset, StreamError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::sync::Mutex;

const CLIENT_VERSION: &str = "0.1.0";

// Command types from the test runner
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    #[serde(rename = "type")]
    cmd_type: String,
    server_url: Option<String>,
    timeout_ms: Option<u64>,
    path: Option<String>,
    // Create fields
    content_type: Option<String>,
    ttl_seconds: Option<u64>,
    expires_at: Option<String>,
    // Append fields
    data: Option<String>,
    binary: Option<bool>,
    seq: Option<i32>,
    // Producer fields
    producer_id: Option<String>,
    epoch: Option<i32>,
    auto_claim: Option<bool>,
    max_in_flight: Option<usize>,
    items: Option<Vec<String>>,
    // Read fields
    offset: Option<String>,
    live: Option<Value>,
    max_chunks: Option<usize>,
    wait_for_up_to_date: Option<bool>,
    // Benchmark fields
    iteration_id: Option<String>,
    operation: Option<BenchmarkOperation>,
    // Headers
    headers: Option<HashMap<String, String>>,
    // Dynamic header/param fields
    name: Option<String>,
    value_type: Option<String>,
    initial_value: Option<String>,
    // Validation fields
    target: Option<ValidationTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidationTarget {
    target: String,
    epoch: Option<i64>,
    max_batch_bytes: Option<i64>,
    max_retries: Option<i64>,
    initial_delay_ms: Option<i64>,
    max_delay_ms: Option<i64>,
    multiplier: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkOperation {
    op: String,
    path: Option<String>,
    size: Option<usize>,
    offset: Option<String>,
    live: Option<String>,
    content_type: Option<String>,
    count: Option<usize>,
    #[serde(rename = "concurrency")]
    _concurrency: Option<usize>,
}

// Result types sent back to test runner
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Result {
    #[serde(rename = "type")]
    result_type: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    features: Option<Features>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunks: Option<Vec<ReadChunk>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    up_to_date: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duplicate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    iteration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metrics: Option<BenchmarkMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers_sent: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params_sent: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Features {
    batching: bool,
    sse: bool,
    long_poll: bool,
    auto: bool,
    streaming: bool,
    dynamic_headers: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadChunk {
    data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkMetrics {
    bytes_transferred: usize,
    messages_processed: usize,
    ops_per_second: f64,
    bytes_per_second: f64,
}

// Dynamic value state
struct DynamicValue {
    value_type: String,
    counter: AtomicI64,
    token_value: String,
}

struct AppState {
    server_url: String,
    client: Client,
    stream_content_types: HashMap<String, String>,
    dynamic_headers: HashMap<String, DynamicValue>,
    dynamic_params: HashMap<String, DynamicValue>,
}

fn main() {
    let rt = Runtime::new().unwrap();
    let state = Arc::new(Mutex::new(None::<AppState>));

    let stdin = io::stdin();
    let stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.is_empty() {
            continue;
        }

        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                let result = error_result("unknown", "PARSE_ERROR", &format!("failed to parse command: {}", e));
                println!("{}", serde_json::to_string(&result).unwrap());
                continue;
            }
        };

        let result = rt.block_on(handle_command(&state, cmd));
        let output = serde_json::to_string(&result).unwrap();
        println!("{}", output);
        stdout.lock().flush().unwrap();

        if result.result_type == "shutdown" {
            break;
        }
    }
}

async fn handle_command(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    match cmd.cmd_type.as_str() {
        "init" => handle_init(state, cmd).await,
        "create" => handle_create(state, cmd).await,
        "connect" => handle_connect(state, cmd).await,
        "append" => handle_append(state, cmd).await,
        "read" => handle_read(state, cmd).await,
        "head" => handle_head(state, cmd).await,
        "delete" => handle_delete(state, cmd).await,
        "benchmark" => handle_benchmark(state, cmd).await,
        "set-dynamic-header" => handle_set_dynamic_header(state, cmd).await,
        "set-dynamic-param" => handle_set_dynamic_param(state, cmd).await,
        "clear-dynamic" => handle_clear_dynamic(state, cmd).await,
        "idempotent-append" => handle_idempotent_append(state, cmd).await,
        "idempotent-append-batch" => handle_idempotent_append_batch(state, cmd).await,
        "validate" => handle_validate(cmd),
        "shutdown" => Result {
            result_type: "shutdown".to_string(),
            success: true,
            ..Default::default()
        },
        _ => error_result(&cmd.cmd_type, "NOT_SUPPORTED", &format!("unknown command type: {}", cmd.cmd_type)),
    }
}

async fn handle_init(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let server_url = cmd.server_url.unwrap_or_default();
    let client = Client::builder()
        .base_url(&server_url)
        .build()
        .expect("Failed to build HTTP client");

    *state.lock().await = Some(AppState {
        server_url,
        client,
        stream_content_types: HashMap::new(),
        dynamic_headers: HashMap::new(),
        dynamic_params: HashMap::new(),
    });

    Result {
        result_type: "init".to_string(),
        success: true,
        client_name: Some("durable-streams-rust".to_string()),
        client_version: Some(CLIENT_VERSION.to_string()),
        features: Some(Features {
            batching: true,
            sse: true,
            long_poll: true,
            auto: true,
            streaming: true,
            dynamic_headers: true,
        }),
        ..Default::default()
    }
}

async fn handle_create(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let stream = app_state.client.stream(&path);

    let content_type = cmd.content_type.unwrap_or_else(|| "application/octet-stream".to_string());

    // Check if stream already exists
    let already_exists = stream.head().await.is_ok();

    let mut options = CreateOptions::new().content_type(&content_type);

    if let Some(ttl) = cmd.ttl_seconds {
        options = options.ttl(Duration::from_secs(ttl));
    }

    if let Some(expires) = cmd.expires_at {
        options = options.expires_at(expires);
    }

    if let Some(headers) = cmd.headers {
        for (k, v) in headers {
            options = options.header(k, v);
        }
    }

    match stream.create_with(options).await {
        Ok(()) => {
            app_state.stream_content_types.insert(path.clone(), content_type);

            // Get the offset after creation
            match stream.head().await {
                Ok(meta) => Result {
                    result_type: "create".to_string(),
                    success: true,
                    status: Some(if already_exists { 200 } else { 201 }),
                    offset: Some(meta.next_offset.to_string()),
                    ..Default::default()
                },
                Err(e) => stream_error_result("create", e),
            }
        }
        Err(e) => stream_error_result("create", e),
    }
}

async fn handle_connect(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let stream = app_state.client.stream(&path);

    match stream.head().await {
        Ok(meta) => {
            if let Some(ct) = &meta.content_type {
                app_state.stream_content_types.insert(path, ct.clone());
            }

            Result {
                result_type: "connect".to_string(),
                success: true,
                status: Some(200),
                offset: Some(meta.next_offset.to_string()),
                ..Default::default()
            }
        }
        Err(e) => stream_error_result("connect", e),
    }
}

async fn handle_append(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let mut stream = app_state.client.stream(&path);

    // Set content type from cache
    if let Some(ct) = app_state.stream_content_types.get(&path) {
        stream.set_content_type(ct.clone());
    }

    // Resolve dynamic headers/params
    let headers_sent = resolve_dynamic_headers(&app_state.dynamic_headers);
    let params_sent = resolve_dynamic_params(&app_state.dynamic_params);

    // Get data
    let data: Bytes = if cmd.binary.unwrap_or(false) {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cmd.data.unwrap_or_default())
            .unwrap_or_default()
            .into()
    } else {
        cmd.data.unwrap_or_default().into()
    };

    // Build append options
    let mut options = AppendOptions::new();

    if let Some(seq) = cmd.seq {
        if seq > 0 {
            options = options.seq(seq.to_string());
        }
    }

    // Merge dynamic headers with command headers
    for (k, v) in &headers_sent {
        options = options.header(k.clone(), v.clone());
    }
    if let Some(headers) = cmd.headers {
        for (k, v) in headers {
            options = options.header(k, v);
        }
    }

    match stream.append_with(data, options).await {
        Ok(result) => {
            let mut res = Result {
                result_type: "append".to_string(),
                success: true,
                status: Some(200),
                offset: Some(result.next_offset.to_string()),
                ..Default::default()
            };

            if !headers_sent.is_empty() {
                res.headers_sent = Some(headers_sent);
            }
            if !params_sent.is_empty() {
                res.params_sent = Some(params_sent);
            }

            res
        }
        Err(e) => stream_error_result("append", e),
    }
}

async fn handle_read(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let stream = app_state.client.stream(&path);

    // Check if this is a JSON stream from cached content type
    let is_json_stream = app_state
        .stream_content_types
        .get(&path)
        .map(|ct| ct.to_lowercase().contains("application/json"))
        .unwrap_or(false);

    let timeout_ms = cmd.timeout_ms.unwrap_or(5000);

    // Resolve dynamic headers/params
    let headers_sent = resolve_dynamic_headers(&app_state.dynamic_headers);
    let params_sent = resolve_dynamic_params(&app_state.dynamic_params);

    // Determine live mode
    let live_mode = match &cmd.live {
        Some(Value::String(s)) => match s.as_str() {
            "long-poll" => LiveMode::LongPoll,
            "sse" => LiveMode::Sse,
            "auto" => LiveMode::Auto,
            _ => LiveMode::Off,
        },
        Some(Value::Bool(false)) => LiveMode::Off,
        _ => LiveMode::Off,
    };

    // Build reader
    let mut builder = stream
        .read()
        .live(live_mode.clone())
        .timeout(Duration::from_millis(timeout_ms));

    if let Some(offset) = &cmd.offset {
        builder = builder.offset(Offset::parse(offset));
    }

    // Merge dynamic headers with command headers
    for (k, v) in &headers_sent {
        builder = builder.header(k.clone(), v.clone());
    }
    if let Some(headers) = cmd.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    let mut chunks_result = Vec::new();
    let max_chunks = cmd.max_chunks.unwrap_or(100);
    let wait_for_up_to_date = cmd.wait_for_up_to_date.unwrap_or(false);

    let mut final_offset = cmd.offset.clone().unwrap_or_else(|| "-1".to_string());
    let mut up_to_date = false;
    let mut status = 200u16;

    match Ok(builder.build()) {
        Ok(mut iter) => {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);

            while chunks_result.len() < max_chunks {
                if Instant::now() > deadline {
                    up_to_date = true;
                    status = 204;
                    break;
                }

                let chunk_result = tokio::time::timeout(
                    Duration::from_millis(timeout_ms.saturating_sub(Instant::now().elapsed().as_millis() as u64)),
                    iter.next_chunk(),
                )
                .await;

                match chunk_result {
                    Ok(Ok(Some(chunk))) => {
                        if let Some(code) = chunk.status_code {
                            status = code;
                        }

                        if !chunk.data.is_empty() {
                            let data_str = String::from_utf8_lossy(&chunk.data).to_string();

                            // Validate JSON for JSON streams
                            if is_json_stream {
                                if let Err(e) = serde_json::from_str::<Value>(&data_str) {
                                    return error_result(
                                        "read",
                                        "PARSE_ERROR",
                                        &format!("Invalid JSON in stream response: {}", e),
                                    );
                                }
                            }

                            chunks_result.push(ReadChunk {
                                data: data_str,
                                binary: None,
                                offset: Some(chunk.next_offset.to_string()),
                            });
                        }

                        final_offset = chunk.next_offset.to_string();
                        up_to_date = chunk.up_to_date;

                        if wait_for_up_to_date && chunk.up_to_date {
                            break;
                        }

                        if live_mode == LiveMode::Off && chunk.up_to_date {
                            break;
                        }
                    }
                    Ok(Ok(None)) => {
                        up_to_date = true;
                        break;
                    }
                    Ok(Err(e)) => {
                        return stream_error_result("read", e);
                    }
                    Err(_) => {
                        // Timeout
                        up_to_date = true;
                        status = 204;
                        break;
                    }
                }
            }

            let mut res = Result {
                result_type: "read".to_string(),
                success: true,
                status: Some(status),
                chunks: Some(chunks_result),
                offset: Some(final_offset),
                up_to_date: Some(up_to_date),
                ..Default::default()
            };

            if !headers_sent.is_empty() {
                res.headers_sent = Some(headers_sent);
            }
            if !params_sent.is_empty() {
                res.params_sent = Some(params_sent);
            }

            res
        }
        Err(e) => stream_error_result("read", e),
    }
}

async fn handle_head(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let guard = state.lock().await;
    let app_state = guard.as_ref().unwrap();

    let path = cmd.path.unwrap_or_default();
    let stream = app_state.client.stream(&path);

    match stream.head().await {
        Ok(meta) => Result {
            result_type: "head".to_string(),
            success: true,
            status: Some(200),
            offset: Some(meta.next_offset.to_string()),
            content_type: meta.content_type,
            ..Default::default()
        },
        Err(e) => stream_error_result("head", e),
    }
}

async fn handle_delete(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let stream = app_state.client.stream(&path);

    match stream.delete().await {
        Ok(()) => {
            app_state.stream_content_types.remove(&path);

            Result {
                result_type: "delete".to_string(),
                success: true,
                status: Some(200),
                ..Default::default()
            }
        }
        Err(e) => stream_error_result("delete", e),
    }
}

async fn handle_set_dynamic_header(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let name = cmd.name.unwrap_or_default();
    let value_type = cmd.value_type.unwrap_or_default();
    let initial_value = cmd.initial_value.unwrap_or_default();

    app_state.dynamic_headers.insert(
        name,
        DynamicValue {
            value_type,
            counter: AtomicI64::new(0),
            token_value: initial_value,
        },
    );

    Result {
        result_type: "set-dynamic-header".to_string(),
        success: true,
        ..Default::default()
    }
}

async fn handle_set_dynamic_param(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let name = cmd.name.unwrap_or_default();
    let value_type = cmd.value_type.unwrap_or_default();

    app_state.dynamic_params.insert(
        name,
        DynamicValue {
            value_type,
            counter: AtomicI64::new(0),
            token_value: String::new(),
        },
    );

    Result {
        result_type: "set-dynamic-param".to_string(),
        success: true,
        ..Default::default()
    }
}

async fn handle_clear_dynamic(state: &Arc<Mutex<Option<AppState>>>, _cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    app_state.dynamic_headers.clear();
    app_state.dynamic_params.clear();

    Result {
        result_type: "clear-dynamic".to_string(),
        success: true,
        ..Default::default()
    }
}

async fn handle_idempotent_append(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let url = format!("{}{}", app_state.server_url, path);

    let content_type = app_state
        .stream_content_types
        .get(&path)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let producer_id = cmd.producer_id.unwrap_or_default();
    let epoch = cmd.epoch.unwrap_or(0) as u64;
    let auto_claim = cmd.auto_claim.unwrap_or(false);

    let stream = app_state.client.stream(&url);
    let producer = stream
        .producer(&producer_id)
        .epoch(epoch)
        .auto_claim(auto_claim)
        .max_in_flight(1)
        .linger(Duration::ZERO)
        .content_type(&content_type)
        .build();

    let data = cmd.data.unwrap_or_default();

    // For JSON streams, the data is already JSON string
    let is_json = content_type.to_lowercase().contains("application/json");

    if is_json {
        match serde_json::from_str::<Value>(&data) {
            Ok(v) => producer.append_json(&v),
            Err(e) => {
                return error_result("idempotent-append", "PARSE_ERROR", &format!("invalid JSON: {}", e));
            }
        }
    } else {
        producer.append(Bytes::from(data));
    }

    if let Err(e) = producer.flush().await {
        return producer_error_result("idempotent-append", e);
    }

    Result {
        result_type: "idempotent-append".to_string(),
        success: true,
        status: Some(200),
        ..Default::default()
    }
}

async fn handle_idempotent_append_batch(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let mut guard = state.lock().await;
    let app_state = guard.as_mut().unwrap();

    let path = cmd.path.unwrap_or_default();
    let url = format!("{}{}", app_state.server_url, path);

    let content_type = app_state
        .stream_content_types
        .get(&path)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let producer_id = cmd.producer_id.unwrap_or_default();
    let epoch = cmd.epoch.unwrap_or(0) as u64;
    let auto_claim = cmd.auto_claim.unwrap_or(false);
    let max_in_flight = cmd.max_in_flight.unwrap_or(1);

    // When testing concurrency, use small batches
    let testing_concurrency = max_in_flight > 1;
    let linger = if testing_concurrency {
        Duration::ZERO
    } else {
        Duration::from_secs(1)
    };
    let max_batch_bytes = if testing_concurrency { 1 } else { 1024 * 1024 };

    let stream = app_state.client.stream(&url);
    let producer = stream
        .producer(&producer_id)
        .epoch(epoch)
        .auto_claim(auto_claim)
        .max_in_flight(max_in_flight)
        .linger(linger)
        .max_batch_bytes(max_batch_bytes)
        .content_type(&content_type)
        .build();

    let items = cmd.items.unwrap_or_default();
    let is_json = content_type.to_lowercase().contains("application/json");

    for item in items {
        if is_json {
            match serde_json::from_str::<Value>(&item) {
                Ok(v) => producer.append_json(&v),
                Err(e) => {
                    return error_result("idempotent-append-batch", "PARSE_ERROR", &format!("invalid JSON: {}", e));
                }
            }
        } else {
            producer.append(Bytes::from(item));
        }
    }

    if let Err(e) = producer.flush().await {
        return producer_error_result("idempotent-append-batch", e);
    }

    Result {
        result_type: "idempotent-append-batch".to_string(),
        success: true,
        status: Some(200),
        ..Default::default()
    }
}

fn handle_validate(cmd: Command) -> Result {
    let target = match cmd.target {
        Some(t) => t,
        None => {
            return error_result("validate", "PARSE_ERROR", "missing target");
        }
    };

    match target.target.as_str() {
        "idempotent-producer" => {
            let epoch = target.epoch.unwrap_or(0);
            let max_batch_bytes = target.max_batch_bytes.unwrap_or(1_048_576);

            if epoch < 0 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("epoch must be non-negative, got: {}", epoch));
            }

            if max_batch_bytes < 1 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("maxBatchBytes must be positive, got: {}", max_batch_bytes));
            }

            Result {
                result_type: "validate".to_string(),
                success: true,
                ..Default::default()
            }
        }
        "retry-options" => {
            let max_retries = target.max_retries.unwrap_or(3);
            let initial_delay_ms = target.initial_delay_ms.unwrap_or(100);
            let max_delay_ms = target.max_delay_ms.unwrap_or(5000);
            let multiplier = target.multiplier.unwrap_or(2.0);

            if max_retries < 0 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("maxRetries must be non-negative, got: {}", max_retries));
            }

            if initial_delay_ms < 1 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("initialDelayMs must be positive, got: {}", initial_delay_ms));
            }

            if max_delay_ms < 1 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("maxDelayMs must be positive, got: {}", max_delay_ms));
            }

            if multiplier < 1.0 {
                return error_result("validate", "INVALID_ARGUMENT", &format!("multiplier must be >= 1.0, got: {}", multiplier));
            }

            Result {
                result_type: "validate".to_string(),
                success: true,
                ..Default::default()
            }
        }
        _ => error_result("validate", "NOT_SUPPORTED", &format!("unknown validation target: {}", target.target)),
    }
}

async fn handle_benchmark(state: &Arc<Mutex<Option<AppState>>>, cmd: Command) -> Result {
    let op = match cmd.operation {
        Some(o) => o,
        None => {
            return error_result("benchmark", "PARSE_ERROR", "missing operation");
        }
    };

    let guard = state.lock().await;
    let app_state = guard.as_ref().unwrap();

    let (duration_ns, metrics) = match op.op.as_str() {
        "append" => benchmark_append(app_state, &op).await,
        "read" => benchmark_read(app_state, &op).await,
        "roundtrip" => benchmark_roundtrip(app_state, &op).await,
        "create" => benchmark_create(app_state, &op).await,
        "throughput_append" => benchmark_throughput_append(app_state, &op).await,
        "throughput_read" => benchmark_throughput_read(app_state, &op).await,
        _ => {
            return error_result("benchmark", "NOT_SUPPORTED", &format!("unknown benchmark op: {}", op.op));
        }
    };

    Result {
        result_type: "benchmark".to_string(),
        success: true,
        iteration_id: cmd.iteration_id,
        duration_ns: Some(duration_ns.to_string()),
        metrics,
        ..Default::default()
    }
}

async fn benchmark_append(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let size = op.size.unwrap_or(100);

    let mut stream = app_state.client.stream(path);
    if let Some(ct) = app_state.stream_content_types.get(path) {
        stream.set_content_type(ct.clone());
    }

    let data: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();

    let start = Instant::now();
    let _ = stream.append(Bytes::from(data)).await;
    (start.elapsed().as_nanos() as i64, None)
}

async fn benchmark_read(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let stream = app_state.client.stream(path);

    let mut builder = stream.read();
    if let Some(offset) = &op.offset {
        builder = builder.offset(Offset::parse(offset));
    }

    let start = Instant::now();
    let mut iter = builder.build();
    let _ = iter.next_chunk().await;
    (start.elapsed().as_nanos() as i64, None)
}

async fn benchmark_roundtrip(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let size = op.size.unwrap_or(100);
    let live = op.live.as_ref().map(|s| s.as_str()).unwrap_or("long-poll");

    let mut stream = app_state.client.stream(path);
    if let Some(ct) = &op.content_type {
        stream.set_content_type(ct.clone());
    } else if let Some(ct) = app_state.stream_content_types.get(path) {
        stream.set_content_type(ct.clone());
    }

    let data: Vec<u8> = (0..size).map(|i| (i % 256) as u8).collect();

    let start = Instant::now();

    // Append
    let result = stream.append(Bytes::from(data)).await;

    if let Ok(append_result) = result {
        // Calculate offset before our append
        let next_offset_str = append_result.next_offset.to_string();
        if let Ok(next_offset_int) = next_offset_str.parse::<i64>() {
            let prev_offset = (next_offset_int - size as i64).to_string();

            let live_mode = match live {
                "sse" => LiveMode::Sse,
                _ => LiveMode::LongPoll,
            };

            let mut iter = stream.read()
                .offset(Offset::parse(&prev_offset))
                .live(live_mode)
                .build();
            let _ = iter.next_chunk().await;
        }
    }

    (start.elapsed().as_nanos() as i64, None)
}

async fn benchmark_create(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let content_type = op.content_type.as_ref().map(|s| s.as_str()).unwrap_or("application/octet-stream");

    let stream = app_state.client.stream(path);

    let start = Instant::now();
    let _ = stream.create_with(CreateOptions::new().content_type(content_type)).await;
    (start.elapsed().as_nanos() as i64, None)
}

async fn benchmark_throughput_append(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let count = op.count.unwrap_or(1000);
    let size = op.size.unwrap_or(100);

    let url = format!("{}{}", app_state.server_url, path);
    let content_type = app_state
        .stream_content_types
        .get(path)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let stream = app_state.client.stream(&url);
    let producer = stream
        .producer("bench-producer")
        .linger(Duration::ZERO)
        .content_type(&content_type)
        .build();

    let payload: Bytes = (0..size).map(|i| (i % 256) as u8).collect::<Vec<u8>>().into();

    let start = Instant::now();

    for _ in 0..count {
        producer.append(payload.clone());
    }

    let _ = producer.flush().await;
    let elapsed = start.elapsed();

    let total_bytes = count * size;
    let ops_per_sec = count as f64 / elapsed.as_secs_f64();
    let bytes_per_sec = total_bytes as f64 / elapsed.as_secs_f64();

    (
        elapsed.as_nanos() as i64,
        Some(BenchmarkMetrics {
            bytes_transferred: total_bytes,
            messages_processed: count,
            ops_per_second: ops_per_sec,
            bytes_per_second: bytes_per_sec,
        }),
    )
}

async fn benchmark_throughput_read(app_state: &AppState, op: &BenchmarkOperation) -> (i64, Option<BenchmarkMetrics>) {
    let path = op.path.as_ref().map(|s| s.as_str()).unwrap_or("");
    let mut stream = app_state.client.stream(path);
    stream.set_content_type("application/json");

    let start = Instant::now();

    let mut total_bytes = 0;
    let mut count = 0;

    let mut iter = stream.read().offset(Offset::Beginning).build();
    {
        loop {
            match iter.next_chunk().await {
                Ok(Some(chunk)) => {
                    // Parse JSON like Go does - count individual items and re-serialize
                    if let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&chunk.data) {
                        for item in items {
                            count += 1;
                            // Re-serialize to count bytes (like Go)
                            if let Ok(bytes) = serde_json::to_vec(&item) {
                                total_bytes += bytes.len();
                            }
                        }
                    } else {
                        // Fallback for non-array JSON
                        total_bytes += chunk.data.len();
                        count += 1;
                    }

                    if chunk.up_to_date {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }

    let elapsed = start.elapsed();
    let bytes_per_sec = total_bytes as f64 / elapsed.as_secs_f64();

    (
        elapsed.as_nanos() as i64,
        Some(BenchmarkMetrics {
            bytes_transferred: total_bytes,
            messages_processed: count,
            ops_per_second: 0.0,
            bytes_per_second: bytes_per_sec,
        }),
    )
}

fn resolve_dynamic_headers(headers: &HashMap<String, DynamicValue>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (name, dv) in headers {
        let value = match dv.value_type.as_str() {
            "counter" => {
                let v = dv.counter.fetch_add(1, Ordering::SeqCst) + 1;
                v.to_string()
            }
            "timestamp" => {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    .to_string()
            }
            "token" => dv.token_value.clone(),
            _ => String::new(),
        };
        result.insert(name.clone(), value);
    }
    result
}

fn resolve_dynamic_params(params: &HashMap<String, DynamicValue>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (name, dv) in params {
        let value = match dv.value_type.as_str() {
            "counter" => {
                let v = dv.counter.fetch_add(1, Ordering::SeqCst) + 1;
                v.to_string()
            }
            "timestamp" => {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    .to_string()
            }
            _ => String::new(),
        };
        result.insert(name.clone(), value);
    }
    result
}

fn error_result(cmd_type: &str, code: &str, message: &str) -> Result {
    Result {
        result_type: "error".to_string(),
        success: false,
        command_type: Some(cmd_type.to_string()),
        error_code: Some(code.to_string()),
        message: Some(message.to_string()),
        ..Default::default()
    }
}

fn stream_error_result(cmd_type: &str, err: StreamError) -> Result {
    let status = err.status_code();
    let code = err.to_error_code();

    Result {
        result_type: "error".to_string(),
        success: false,
        command_type: Some(cmd_type.to_string()),
        status,
        error_code: Some(code.to_string()),
        message: Some(err.to_string()),
        ..Default::default()
    }
}

fn producer_error_result(cmd_type: &str, err: durable_streams::ProducerError) -> Result {
    let (code, status) = match &err {
        durable_streams::ProducerError::Closed => ("CLOSED", None),
        durable_streams::ProducerError::StaleEpoch { .. } => ("STALE_EPOCH", Some(403)),
        durable_streams::ProducerError::SequenceGap { .. } => ("SEQUENCE_GAP", Some(409)),
        durable_streams::ProducerError::Stream { .. } => ("STREAM_ERROR", None),
        durable_streams::ProducerError::MixedAppendTypes => ("MIXED_APPEND_TYPES", None),
    };

    Result {
        result_type: "error".to_string(),
        success: false,
        command_type: Some(cmd_type.to_string()),
        status,
        error_code: Some(code.to_string()),
        message: Some(err.to_string()),
        ..Default::default()
    }
}

impl Default for Result {
    fn default() -> Self {
        Self {
            result_type: String::new(),
            success: false,
            client_name: None,
            client_version: None,
            features: None,
            status: None,
            offset: None,
            content_type: None,
            chunks: None,
            up_to_date: None,
            cursor: None,
            headers: None,
            command_type: None,
            error_code: None,
            message: None,
            duplicate: None,
            iteration_id: None,
            duration_ns: None,
            metrics: None,
            headers_sent: None,
            params_sent: None,
        }
    }
}
