//! Stream consumption with ChunkIterator.

use crate::error::StreamError;
use crate::stream::{DurableStream, HEADER_STREAM_CURSOR, HEADER_STREAM_OFFSET, HEADER_STREAM_UP_TO_DATE};
use crate::types::{LiveMode, Offset};
use bytes::Bytes;
use std::time::Duration;

/// A chunk of data from the stream.
///
/// ## Chunk Semantics
///
/// A `Chunk` represents **one unit of data delivery** from the stream:
///
/// | Mode | What `data` contains |
/// |------|---------------------|
/// | **Catch-up** | One HTTP response body |
/// | **Long-poll** | One HTTP response body (data that arrived during poll) |
/// | **SSE** | One SSE data event payload |
///
/// ## `up_to_date` Semantics
///
/// | Mode | `up_to_date == true` means |
/// |------|---------------------------|
/// | **Catch-up** | Response included all available data |
/// | **Long-poll** | Server timed out with no new data (204 response) |
/// | **SSE** | Control event included `upToDate: true` |
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Chunk {
    /// The raw data bytes for this chunk.
    pub data: Bytes,
    /// Next offset to read from (for resumption/checkpointing).
    pub next_offset: Offset,
    /// Whether this chunk represents the current tail of the stream.
    pub up_to_date: bool,
    /// Cursor for CDN request collapsing.
    pub cursor: Option<String>,
    /// HTTP status code from the response, if applicable.
    ///
    /// Common values:
    /// - `Some(200)`: Success with data
    /// - `Some(204)`: No content (long-poll timeout or caught up)
    /// - `Some(304)`: Not modified
    /// - `None`: SSE connection closed, reconnect will happen on next iteration
    pub status_code: Option<u16>,
}

/// Builder for configuring stream reads.
#[derive(Debug)]
#[must_use = "builders do nothing unless you call .build()"]
pub struct ReadBuilder {
    stream: DurableStream,
    offset: Offset,
    live: LiveMode,
    timeout: Duration,
    headers: Vec<(String, String)>,
    cursor: Option<String>,
}

impl ReadBuilder {
    pub(crate) fn new(stream: DurableStream) -> Self {
        Self {
            stream,
            offset: Offset::Beginning,
            live: LiveMode::Off,
            timeout: Duration::from_secs(30),
            headers: Vec::new(),
            cursor: None,
        }
    }

    /// Set the starting offset.
    ///
    /// Accepts `Offset` or string types that convert to `Offset::At`.
    ///
    /// # Examples
    /// ```ignore
    /// stream.read().offset(Offset::Beginning)
    /// stream.read().offset("abc123")  // equivalent to Offset::at("abc123")
    /// ```
    pub fn offset(mut self, offset: impl Into<Offset>) -> Self {
        self.offset = offset.into();
        self
    }

    /// Set the live mode.
    pub fn live(mut self, mode: LiveMode) -> Self {
        self.live = mode;
        self
    }

    /// Set the timeout for long-poll operations.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Add a custom header.
    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }

    /// Set initial cursor for CDN collapsing.
    pub fn cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }

    /// Build the ChunkIterator.
    ///
    /// No network request is made until `next_chunk()` is called.
    pub fn build(self) -> ChunkIterator {
        ChunkIterator {
            stream: self.stream,
            offset: self.offset,
            live: self.live,
            timeout: self.timeout,
            headers: self.headers,
            cursor: self.cursor,
            up_to_date: false,
            closed: false,
            done: false,
            sse_state: None,
        }
    }
}

/// Iterator for reading chunks from a stream.
pub struct ChunkIterator {
    stream: DurableStream,
    offset: Offset,
    live: LiveMode,
    timeout: Duration,
    headers: Vec<(String, String)>,
    cursor: Option<String>,
    up_to_date: bool,
    closed: bool,
    done: bool,
    sse_state: Option<SseState>,
}

struct SseState {
    response: reqwest::Response,
    buffer: String,           // Accumulated bytes from network
    pending_data: Vec<String>, // Accumulated data lines for current event
    current_event_type: Option<String>,
}

impl ChunkIterator {
    /// Get the current offset.
    pub fn offset(&self) -> &Offset {
        &self.offset
    }

    /// Check if we've caught up to the stream tail.
    pub fn is_up_to_date(&self) -> bool {
        self.up_to_date
    }

    /// Get the current cursor.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// Close the iterator and release resources.
    pub fn close(&mut self) {
        self.closed = true;
        self.sse_state = None;
    }

    /// Fetch the next chunk.
    pub async fn next_chunk(&mut self) -> Result<Option<Chunk>, StreamError> {
        if self.closed {
            return Err(StreamError::IteratorClosed);
        }

        if self.done {
            return Ok(None);
        }

        // If we have an active SSE connection, use it
        if self.sse_state.is_some() {
            return self.next_sse_chunk().await;
        }

        // Determine which mode to use
        match self.live {
            LiveMode::Sse => self.establish_sse_and_read().await,
            LiveMode::Auto => {
                if self.up_to_date {
                    // After catching up, try SSE
                    self.establish_sse_and_read().await
                } else {
                    self.next_http(None).await
                }
            }
            LiveMode::LongPoll => self.next_http(Some("long-poll")).await,
            LiveMode::Off => self.next_http(None).await,
        }
    }

    async fn next_http(&mut self, live_param: Option<&str>) -> Result<Option<Chunk>, StreamError> {
        let url = self
            .stream
            .build_read_url(&self.offset, live_param, self.cursor.as_deref());

        let mut req = self.stream.client.inner.get(&url);

        // Add headers
        let client_headers = self.stream.client.get_headers();
        for (key, value) in client_headers.iter() {
            req = req.header(key.clone(), value.clone());
        }
        for (key, value) in &self.headers {
            req = req.header(key.as_str(), value.as_str());
        }

        // Set timeout for long-poll
        if live_param == Some("long-poll") {
            req = req.timeout(self.timeout);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => {
                // Timeout in long-poll means up-to-date
                self.up_to_date = true;
                if self.live == LiveMode::Off {
                    self.done = true;
                    return Ok(None);
                }
                return Ok(Some(Chunk {
                    data: Bytes::new(),
                    next_offset: self.offset.clone(),
                    up_to_date: true,
                    cursor: self.cursor.clone(),
                    status_code: Some(204),
                }));
            }
            Err(e) => return Err(e.into()),
        };

        let status = resp.status().as_u16();

        match status {
            200 => {
                // Extract headers before consuming body
                let next_offset = resp
                    .headers()
                    .get(HEADER_STREAM_OFFSET)
                    .and_then(|v| v.to_str().ok())
                    .map(Offset::parse)
                    .unwrap_or_else(|| self.offset.clone());

                let cursor = resp
                    .headers()
                    .get(HEADER_STREAM_CURSOR)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                let up_to_date = resp
                    .headers()
                    .get(HEADER_STREAM_UP_TO_DATE)
                    .and_then(|v| v.to_str().ok())
                    == Some("true");

                let data = resp.bytes().await?;

                // Update state
                self.offset = next_offset.clone();
                self.cursor = cursor.clone();
                self.up_to_date = up_to_date;

                if up_to_date && self.live == LiveMode::Off {
                    self.done = true;
                }

                Ok(Some(Chunk {
                    data,
                    next_offset,
                    up_to_date,
                    cursor,
                    status_code: Some(200),
                }))
            }
            204 => {
                // No content - long-poll timeout or caught up
                let next_offset = resp
                    .headers()
                    .get(HEADER_STREAM_OFFSET)
                    .and_then(|v| v.to_str().ok())
                    .map(Offset::parse);

                let cursor = resp
                    .headers()
                    .get(HEADER_STREAM_CURSOR)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                if let Some(offset) = next_offset {
                    self.offset = offset;
                }
                if cursor.is_some() {
                    self.cursor = cursor.clone();
                }
                self.up_to_date = true; // 204 always means up-to-date

                if self.live == LiveMode::Off {
                    self.done = true;
                    return Ok(None);
                }

                Ok(Some(Chunk {
                    data: Bytes::new(),
                    next_offset: self.offset.clone(),
                    up_to_date: true,
                    cursor: self.cursor.clone(),
                    status_code: Some(204),
                }))
            }
            304 => {
                // Not modified - just advance cursor
                if let Some(cursor) = resp
                    .headers()
                    .get(HEADER_STREAM_CURSOR)
                    .and_then(|v| v.to_str().ok())
                {
                    self.cursor = Some(cursor.to_string());
                }

                Ok(Some(Chunk {
                    data: Bytes::new(),
                    next_offset: self.offset.clone(),
                    up_to_date: self.up_to_date,
                    cursor: self.cursor.clone(),
                    status_code: Some(304),
                }))
            }
            404 => Err(StreamError::NotFound {
                url: self.stream.url.clone(),
            }),
            410 => Err(StreamError::OffsetGone {
                offset: self.offset.to_string(),
            }),
            _ => Err(StreamError::from_status(status, &self.stream.url)),
        }
    }

    async fn establish_sse_and_read(&mut self) -> Result<Option<Chunk>, StreamError> {
        // Establish SSE connection
        let url = self
            .stream
            .build_read_url(&self.offset, Some("sse"), self.cursor.as_deref());

        let mut req = self
            .stream
            .client
            .inner
            .get(&url)
            .header("Accept", "text/event-stream");

        // Add headers
        let client_headers = self.stream.client.get_headers();
        for (key, value) in client_headers.iter() {
            req = req.header(key.clone(), value.clone());
        }
        for (key, value) in &self.headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();

        match status {
            200 => {
                // Check content type
                let content_type = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");

                if !content_type.contains("text/event-stream") {
                    // Fall back to long-poll
                    self.live = LiveMode::LongPoll;
                    return self.next_http(Some("long-poll")).await;
                }

                self.sse_state = Some(SseState {
                    response: resp,
                    buffer: String::new(),
                    pending_data: Vec::new(),
                    current_event_type: None,
                });

                self.next_sse_chunk().await
            }
            400 => {
                // SSE not supported - fall back to long-poll
                self.live = LiveMode::LongPoll;
                self.next_http(Some("long-poll")).await
            }
            404 => Err(StreamError::NotFound {
                url: self.stream.url.clone(),
            }),
            _ => Err(StreamError::from_status(status, &self.stream.url)),
        }
    }

    async fn next_sse_chunk(&mut self) -> Result<Option<Chunk>, StreamError> {
        // Get SSE state, or establish connection if needed
        let state = match &mut self.sse_state {
            Some(s) => s,
            None => {
                // Connection was closed, need to re-establish
                // But to avoid recursion, just fall back to HTTP for this call
                return self.next_http(Some("long-poll")).await;
            }
        };

        // Read from SSE stream
        loop {
            // First, try to process any complete lines in the buffer
            while let Some(newline_pos) = state.buffer.find('\n') {
                let line = state.buffer[..newline_pos].trim_end_matches('\r').to_string();
                state.buffer = state.buffer[newline_pos + 1..].to_string();

                // Empty line = event dispatch
                if line.is_empty() {
                    if !state.pending_data.is_empty() {
                        let data = state.pending_data.join("\n");
                        let event_type = state.current_event_type.take();
                        state.pending_data.clear();

                        match event_type.as_deref() {
                            Some("control") => {
                                // Parse control event JSON
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                                    let stream_next_offset = json
                                        .get("streamNextOffset")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();

                                    let stream_cursor = json
                                        .get("streamCursor")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());

                                    let up_to_date = json
                                        .get("upToDate")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);

                                    // Update state
                                    self.offset = Offset::parse(&stream_next_offset);
                                    if let Some(cursor) = stream_cursor {
                                        self.cursor = Some(cursor);
                                    }
                                    self.up_to_date = up_to_date;

                                    // Control-only event (no data)
                                    if up_to_date {
                                        return Ok(Some(Chunk {
                                            data: Bytes::new(),
                                            next_offset: self.offset.clone(),
                                            up_to_date: true,
                                            cursor: self.cursor.clone(),
                                            status_code: Some(200),
                                        }));
                                    }
                                }
                            }
                            _ => {
                                // Data event - return immediately
                                return Ok(Some(Chunk {
                                    data: Bytes::from(data),
                                    next_offset: self.offset.clone(),
                                    up_to_date: self.up_to_date,
                                    cursor: self.cursor.clone(),
                                    status_code: Some(200),
                                }));
                            }
                        }
                    }
                    continue;
                }

                // Parse SSE field
                if let Some(rest) = line.strip_prefix("event:") {
                    state.current_event_type = Some(rest.trim_start().to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    state.pending_data.push(rest.trim_start().to_string());
                }
                // Ignore other fields (id:, retry:, comments starting with :)
            }

            // Need more data from network
            let chunk = match state.response.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => {
                    // Connection closed
                    self.sse_state = None;
                    if self.live.is_live() {
                        // Return with indication to reconnect on next call
                        return Ok(Some(Chunk {
                            data: Bytes::new(),
                            next_offset: self.offset.clone(),
                            up_to_date: self.up_to_date,
                            cursor: self.cursor.clone(),
                            status_code: None, // SSE closed, reconnect on next iteration
                        }));
                    }
                    self.done = true;
                    return Ok(None);
                }
                Err(e) => return Err(e.into()),
            };

            // Append to buffer
            let text = String::from_utf8_lossy(&chunk);
            state.buffer.push_str(&text);
        }
    }
}

// Note: We don't implement futures::Stream here because the async recursion
// makes it complex. Users should use next_chunk() directly in a loop.
