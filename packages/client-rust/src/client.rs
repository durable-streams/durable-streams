//! HTTP client and configuration.

use crate::error::InvalidHeaderError;
use crate::stream::DurableStream;
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

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.base_url)
            .field("default_headers", &self.default_headers)
            .field("has_header_provider", &self.header_provider.is_some())
            .finish()
    }
}

impl Client {
    /// Create a new client with default settings.
    ///
    /// # Panics
    ///
    /// Panics if the HTTP client fails to build. Use `Client::builder().build()`
    /// for fallible construction.
    pub fn new() -> Self {
        ClientBuilder::new()
            .build()
            .expect("Failed to build default HTTP client")
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
    pub fn stream(&self, url: &str) -> DurableStream {
        let full_url = if url.starts_with("http://") || url.starts_with("https://") {
            url.to_string()
        } else if let Some(base) = &self.base_url {
            format!("{}{}", base.trim_end_matches('/'), url)
        } else {
            url.to_string()
        };

        DurableStream {
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
#[must_use = "builders do nothing unless you call .build()"]
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
    ///
    /// Invalid header names or values are silently ignored. Use
    /// [`try_default_header`](Self::try_default_header) if you need error handling.
    pub fn default_header(mut self, key: &str, value: &str) -> Self {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(key.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            self.default_headers.insert(name, val);
        }
        self
    }

    /// Add a default header, returning an error if the name or value is invalid.
    ///
    /// Use this instead of [`default_header`](Self::default_header) when you need
    /// to know if header configuration failed.
    pub fn try_default_header(
        mut self,
        key: &str,
        value: &str,
    ) -> std::result::Result<Self, InvalidHeaderError> {
        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| InvalidHeaderError::InvalidName(key.to_string()))?;
        let val = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| InvalidHeaderError::InvalidValue(value.to_string()))?;
        self.default_headers.insert(name, val);
        Ok(self)
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
    ///
    /// Returns an error if the underlying HTTP client fails to build
    /// (e.g., due to TLS configuration issues).
    pub fn build(self) -> Result<Client, reqwest::Error> {
        let mut builder = reqwest::Client::builder()
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(Duration::from_secs(90));

        if let Some(timeout) = self.timeout {
            builder = builder.timeout(timeout);
        }

        let inner = builder.build()?;

        Ok(Client {
            inner,
            base_url: self.base_url,
            default_headers: self.default_headers,
            header_provider: self.header_provider,
        })
    }
}

impl Default for ClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}
