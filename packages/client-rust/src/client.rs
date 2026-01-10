//! HTTP client and configuration.

use crate::stream::Stream;
use reqwest::header::HeaderMap;
use std::sync::Arc;
use std::time::Duration;

/// A Durable Streams client.
///
/// The client is cloneable and can be shared across threads.
/// It manages connection pooling.
#[derive(Clone)]
pub struct Client {
    pub(crate) inner: reqwest::Client,
    pub(crate) base_url: Option<String>,
    pub(crate) default_headers: HeaderMap,
    pub(crate) header_provider: Option<Arc<dyn Fn() -> HeaderMap + Send + Sync>>,
}

impl Client {
    /// Create a new client with default settings.
    pub fn new() -> Self {
        ClientBuilder::new().build()
    }

    /// Create a client builder for customization.
    pub fn builder() -> ClientBuilder {
        ClientBuilder::new()
    }

    /// Create a stream handle for the given URL.
    ///
    /// No network request is made until an operation is called.
    ///
    /// The url can be:
    /// - A full URL: "https://example.com/streams/my-stream"
    /// - A path (if base_url was set): "/streams/my-stream"
    pub fn stream(&self, url: &str) -> Stream {
        let full_url = if url.starts_with("http://") || url.starts_with("https://") {
            url.to_string()
        } else if let Some(base) = &self.base_url {
            format!("{}{}", base.trim_end_matches('/'), url)
        } else {
            url.to_string()
        };

        Stream {
            url: full_url,
            client: self.clone(),
            content_type: None,
        }
    }

    /// Get headers for a request, including dynamic headers if configured.
    pub(crate) fn get_headers(&self) -> HeaderMap {
        let mut headers = self.default_headers.clone();
        if let Some(provider) = &self.header_provider {
            for (key, value) in provider().iter() {
                headers.insert(key.clone(), value.clone());
            }
        }
        headers
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for configuring a Client.
pub struct ClientBuilder {
    base_url: Option<String>,
    default_headers: HeaderMap,
    timeout: Option<Duration>,
    header_provider: Option<Arc<dyn Fn() -> HeaderMap + Send + Sync>>,
}

impl ClientBuilder {
    /// Create a new client builder.
    pub fn new() -> Self {
        Self {
            base_url: None,
            default_headers: HeaderMap::new(),
            timeout: None,
            header_provider: None,
        }
    }

    /// Set the base URL for relative paths.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Add a default header for all requests.
    pub fn default_header(mut self, key: &str, value: &str) -> Self {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(key.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            self.default_headers.insert(name, val);
        }
        self
    }

    /// Set all default headers.
    pub fn default_headers(mut self, headers: HeaderMap) -> Self {
        self.default_headers = headers;
        self
    }

    /// Set the request timeout.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Set a dynamic header provider (called per-request).
    pub fn header_provider<F>(mut self, provider: F) -> Self
    where
        F: Fn() -> HeaderMap + Send + Sync + 'static,
    {
        self.header_provider = Some(Arc::new(provider));
        self
    }

    /// Build the client.
    pub fn build(self) -> Client {
        let mut builder = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(Duration::from_secs(90));

        if let Some(timeout) = self.timeout {
            builder = builder.timeout(timeout);
        }

        let inner = builder.build().expect("Failed to build HTTP client");

        Client {
            inner,
            base_url: self.base_url,
            default_headers: self.default_headers,
            header_provider: self.header_provider,
        }
    }
}

impl Default for ClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}
