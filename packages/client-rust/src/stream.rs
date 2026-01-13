//! Stream handle and operations.

use crate::client::Client;
use crate::error::StreamError;
use crate::iterator::ReadBuilder;
use crate::producer::ProducerBuilder;
use crate::types::Offset;
use bytes::Bytes;
use std::time::Duration;

/// Protocol header names
pub(crate) const HEADER_CONTENT_TYPE: &str = "content-type";
pub(crate) const HEADER_STREAM_OFFSET: &str = "stream-next-offset";
pub(crate) const HEADER_STREAM_CURSOR: &str = "stream-cursor";
pub(crate) const HEADER_STREAM_UP_TO_DATE: &str = "stream-up-to-date";
pub(crate) const HEADER_STREAM_SEQ: &str = "stream-seq";
pub(crate) const HEADER_STREAM_TTL: &str = "stream-ttl";
pub(crate) const HEADER_STREAM_EXPIRES: &str = "stream-expires-at";
pub(crate) const HEADER_ETAG: &str = "etag";
pub(crate) const HEADER_IF_MATCH: &str = "if-match";

/// Producer headers
pub(crate) const HEADER_PRODUCER_ID: &str = "producer-id";
pub(crate) const HEADER_PRODUCER_EPOCH: &str = "producer-epoch";
pub(crate) const HEADER_PRODUCER_SEQ: &str = "producer-seq";
pub(crate) const HEADER_PRODUCER_EXPECTED_SEQ: &str = "producer-expected-seq";

/// Maximum retries for transient errors on append operations
const MAX_APPEND_RETRIES: u32 = 3;

/// A handle to a durable stream.
///
/// This is a lightweight, cloneable object - not a persistent connection.
/// Operations make HTTP requests on demand.
#[derive(Clone, Debug)]
pub struct DurableStream {
    pub(crate) url: String,
    pub(crate) client: Client,
    pub(crate) content_type: Option<String>,
}

impl DurableStream {
    /// Get the stream URL.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Get the content type set on this stream handle.
    ///
    /// This is used as the default Content-Type for append operations
    /// and by the Producer for JSON mode detection.
    ///
    /// Note: This is not automatically populated from the server.
    /// Use [`set_content_type`](Self::set_content_type) to set it after
    /// creating a stream, or set it explicitly on the Producer.
    pub fn content_type(&self) -> Option<&str> {
        self.content_type.as_deref()
    }

    /// Set the content type for this stream handle.
    ///
    /// This affects append operations and Producer JSON mode detection.
    ///
    /// # Example
    /// ```ignore
    /// let mut stream = client.stream("...");
    /// stream.set_content_type("application/json");
    /// ```
    pub fn set_content_type(&mut self, ct: impl Into<String>) {
        self.content_type = Some(ct.into());
    }

    /// Create the stream.
    ///
    /// Idempotent - succeeds if stream already exists with matching config.
    /// Returns `StreamError::Conflict` only if config differs.
    pub async fn create(&self) -> Result<(), StreamError> {
        self.create_with(CreateOptions::default()).await
    }

    /// Create the stream with options.
    pub async fn create_with(&self, options: CreateOptions) -> Result<(), StreamError> {
        let content_type = options
            .content_type
            .as_deref()
            .unwrap_or("application/octet-stream");

        let mut req = self
            .client
            .inner
            .put(&self.url)
            .header(HEADER_CONTENT_TYPE, content_type);

        // Add TTL header if specified
        if let Some(ttl) = options.ttl {
            req = req.header(HEADER_STREAM_TTL, ttl.as_secs().to_string());
        }

        // Add expires header if specified
        if let Some(expires) = &options.expires_at {
            req = req.header(HEADER_STREAM_EXPIRES, expires);
        }

        // Add custom headers
        let client_headers = self.client.get_headers();
        for (key, value) in client_headers.iter() {
            req = req.header(key.clone(), value.clone());
        }

        for (key, value) in &options.headers {
            req = req.header(key.as_str(), value.as_str());
        }

        // Add initial data if provided
        if let Some(data) = options.initial_data {
            req = req.body(data);
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();

        match status {
            200 | 201 | 204 => Ok(()),
            409 => Err(StreamError::Conflict),
            _ => Err(StreamError::from_status(status, &self.url)),
        }
    }

    /// Append data to the stream.
    pub async fn append(&self, data: impl Into<Bytes>) -> Result<AppendResponse, StreamError> {
        self.append_with(data, AppendOptions::default()).await
    }

    /// Append data with options.
    pub async fn append_with(
        &self,
        data: impl Into<Bytes>,
        options: AppendOptions,
    ) -> Result<AppendResponse, StreamError> {
        let data = data.into();
        if data.is_empty() {
            return Err(StreamError::EmptyAppend);
        }

        let content_type = self
            .content_type
            .as_deref()
            .unwrap_or("application/octet-stream");

        // Retry logic for transient errors
        let mut last_error = None;

        for attempt in 0..=MAX_APPEND_RETRIES {
            if attempt > 0 {
                // Exponential backoff: 100ms, 200ms, 400ms
                tokio::time::sleep(std::time::Duration::from_millis(100 * (1 << (attempt - 1)))).await;
            }

            let mut req = self
                .client
                .inner
                .post(&self.url)
                .header(HEADER_CONTENT_TYPE, content_type)
                .body(data.clone());

            // Add sequence header if specified
            if let Some(seq) = &options.seq {
                req = req.header(HEADER_STREAM_SEQ, seq.as_str());
            }

            // Add if-match header if specified
            if let Some(etag) = &options.if_match {
                req = req.header(HEADER_IF_MATCH, etag.as_str());
            }

            // Add custom headers
            let client_headers = self.client.get_headers();
            for (key, value) in client_headers.iter() {
                req = req.header(key.clone(), value.clone());
            }

            for (key, value) in &options.headers {
                req = req.header(key.as_str(), value.as_str());
            }

            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    last_error = Some(StreamError::from(e));
                    continue; // Retry on network error
                }
            };

            let status = resp.status().as_u16();

            match status {
                200 | 204 => {
                    let next_offset = resp
                        .headers()
                        .get(HEADER_STREAM_OFFSET)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| Offset::parse(s))
                        .unwrap_or(Offset::Beginning);

                    let etag = resp
                        .headers()
                        .get(HEADER_ETAG)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());

                    return Ok(AppendResponse { next_offset, etag });
                }
                404 => return Err(StreamError::NotFound {
                    url: self.url.clone(),
                }),
                409 => return Err(StreamError::SeqConflict),
                // Retry on transient server errors
                500 | 502 | 503 | 504 | 429 => {
                    last_error = Some(StreamError::from_status(status, &self.url));
                    continue;
                }
                _ => return Err(StreamError::from_status(status, &self.url)),
            }
        }

        // Return last error if all retries failed
        Err(last_error.unwrap_or_else(|| StreamError::ServerError {
            status: 500,
            message: "All retries failed".to_string(),
        }))
    }

    /// Get stream metadata via HEAD request.
    pub async fn head(&self) -> Result<HeadResponse, StreamError> {
        self.head_with(HeadOptions::default()).await
    }

    /// Get stream metadata with options.
    pub async fn head_with(&self, options: HeadOptions) -> Result<HeadResponse, StreamError> {
        let mut req = self.client.inner.head(&self.url);

        // Add custom headers
        let client_headers = self.client.get_headers();
        for (key, value) in client_headers.iter() {
            req = req.header(key.clone(), value.clone());
        }

        for (key, value) in &options.headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();

        match status {
            200 => {
                let next_offset = resp
                    .headers()
                    .get(HEADER_STREAM_OFFSET)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| Offset::parse(s))
                    .unwrap_or(Offset::Beginning);

                let content_type = resp
                    .headers()
                    .get(HEADER_CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                let ttl = resp
                    .headers()
                    .get(HEADER_STREAM_TTL)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(Duration::from_secs);

                let expires_at = resp
                    .headers()
                    .get(HEADER_STREAM_EXPIRES)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                let etag = resp
                    .headers()
                    .get(HEADER_ETAG)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                Ok(HeadResponse {
                    next_offset,
                    content_type,
                    ttl,
                    expires_at,
                    etag,
                })
            }
            404 => Err(StreamError::NotFound {
                url: self.url.clone(),
            }),
            _ => Err(StreamError::from_status(status, &self.url)),
        }
    }

    /// Delete the stream.
    pub async fn delete(&self) -> Result<(), StreamError> {
        self.delete_with(DeleteOptions::default()).await
    }

    /// Delete the stream with options.
    pub async fn delete_with(&self, options: DeleteOptions) -> Result<(), StreamError> {
        let mut req = self.client.inner.delete(&self.url);

        // Add custom headers
        let client_headers = self.client.get_headers();
        for (key, value) in client_headers.iter() {
            req = req.header(key.clone(), value.clone());
        }

        for (key, value) in &options.headers {
            req = req.header(key.as_str(), value.as_str());
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();

        match status {
            200 | 204 => Ok(()),
            404 => Err(StreamError::NotFound {
                url: self.url.clone(),
            }),
            _ => Err(StreamError::from_status(status, &self.url)),
        }
    }

    /// Create a reader builder for consuming the stream.
    pub fn read(&self) -> ReadBuilder {
        ReadBuilder::new(self.clone())
    }

    /// Create an idempotent producer builder.
    pub fn producer(&self, producer_id: impl Into<String>) -> ProducerBuilder {
        ProducerBuilder::new(self.clone(), producer_id.into())
    }

    /// Build a read URL with query parameters.
    pub(crate) fn build_read_url(
        &self,
        offset: &Offset,
        live: Option<&str>,
        cursor: Option<&str>,
    ) -> String {
        let mut url = self.url.clone();
        let mut params = Vec::new();

        // Always include offset
        params.push(format!("offset={}", offset.to_query_value()));

        // Add live mode if specified
        if let Some(live) = live {
            params.push(format!("live={}", live));
        }

        // Add cursor if specified
        if let Some(cursor) = cursor {
            params.push(format!("cursor={}", cursor));
        }

        if !params.is_empty() {
            if url.contains('?') {
                url.push('&');
            } else {
                url.push('?');
            }
            url.push_str(&params.join("&"));
        }

        url
    }
}

/// Options for creating a stream.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct CreateOptions {
    pub content_type: Option<String>,
    pub ttl: Option<Duration>,
    pub expires_at: Option<String>,
    pub headers: Vec<(String, String)>,
    pub initial_data: Option<Bytes>,
}

impl CreateOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn content_type(mut self, ct: impl Into<String>) -> Self {
        self.content_type = Some(ct.into());
        self
    }

    pub fn ttl(mut self, ttl: Duration) -> Self {
        self.ttl = Some(ttl);
        self
    }

    pub fn expires_at(mut self, expires: impl Into<String>) -> Self {
        self.expires_at = Some(expires.into());
        self
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }

    pub fn initial_data(mut self, data: impl Into<Bytes>) -> Self {
        self.initial_data = Some(data.into());
        self
    }
}

/// Options for appending to a stream.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct AppendOptions {
    pub seq: Option<String>,
    pub if_match: Option<String>,
    pub headers: Vec<(String, String)>,
}

impl AppendOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seq(mut self, seq: impl Into<String>) -> Self {
        self.seq = Some(seq.into());
        self
    }

    pub fn if_match(mut self, etag: impl Into<String>) -> Self {
        self.if_match = Some(etag.into());
        self
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
}

/// Options for HEAD request.
#[derive(Clone, Debug, Default)]
pub struct HeadOptions {
    pub headers: Vec<(String, String)>,
}

impl HeadOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
}

/// Options for DELETE request.
#[derive(Clone, Debug, Default)]
pub struct DeleteOptions {
    pub headers: Vec<(String, String)>,
}

impl DeleteOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
}

/// Response from an append operation.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct AppendResponse {
    pub next_offset: Offset,
    pub etag: Option<String>,
}

/// Response from a HEAD operation.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct HeadResponse {
    pub next_offset: Offset,
    pub content_type: Option<String>,
    pub ttl: Option<Duration>,
    pub expires_at: Option<String>,
    pub etag: Option<String>,
}
