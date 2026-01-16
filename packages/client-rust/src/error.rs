//! Error types for the Durable Streams client.

use std::time::Duration;
use thiserror::Error;

/// Error for invalid HTTP header configuration.
#[derive(Debug, Clone, Error)]
pub enum InvalidHeaderError {
    #[error("invalid header name: {0}")]
    InvalidName(String),
    #[error("invalid header value: {0}")]
    InvalidValue(String),
}

/// Main error type for stream operations.
#[derive(Debug, Error)]
pub enum StreamError {
    #[error("stream not found: {url}")]
    NotFound { url: String },

    #[error("stream already exists with different configuration")]
    Conflict,

    #[error("sequence conflict")]
    SeqConflict,

    #[error("offset gone (retention/compaction): {offset}")]
    OffsetGone { offset: String },

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("rate limited")]
    RateLimited { retry_after: Option<Duration> },

    #[error("invalid request: {message}")]
    BadRequest { message: String },

    #[error("server error: {status} - {message}")]
    ServerError { status: u16, message: String },

    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),

    #[error("timeout")]
    Timeout,

    #[error("json error: {0}")]
    Json(String),

    #[error("parse error: {0}")]
    ParseError(String),

    #[error("empty append not allowed")]
    EmptyAppend,

    #[error("iterator closed")]
    IteratorClosed,
}

impl StreamError {
    /// Create error from HTTP status code
    pub fn from_status(status: u16, url: &str) -> Self {
        match status {
            400 => StreamError::BadRequest {
                message: "Bad request".to_string(),
            },
            401 => StreamError::Unauthorized,
            403 => StreamError::Forbidden,
            404 => StreamError::NotFound {
                url: url.to_string(),
            },
            409 => StreamError::Conflict,
            410 => StreamError::OffsetGone {
                offset: String::new(),
            },
            429 => StreamError::RateLimited { retry_after: None },
            _ if status >= 500 => StreamError::ServerError {
                status,
                message: format!("Server error {}", status),
            },
            _ => StreamError::ServerError {
                status,
                message: format!("Unexpected status {}", status),
            },
        }
    }

    /// Whether this error is retryable
    pub fn is_retryable(&self) -> bool {
        match self {
            StreamError::RateLimited { .. } => true,
            StreamError::ServerError { status, .. } => *status >= 500,
            StreamError::Network(_) => true,
            StreamError::Timeout => true,
            _ => false,
        }
    }

    /// HTTP status code if applicable
    pub fn status_code(&self) -> Option<u16> {
        match self {
            StreamError::NotFound { .. } => Some(404),
            StreamError::Conflict => Some(409),
            StreamError::Unauthorized => Some(401),
            StreamError::Forbidden => Some(403),
            StreamError::RateLimited { .. } => Some(429),
            StreamError::BadRequest { .. } => Some(400),
            StreamError::ServerError { status, .. } => Some(*status),
            StreamError::OffsetGone { .. } => Some(410),
            StreamError::SeqConflict => Some(409),
            _ => None,
        }
    }

    /// Convert to error code string for conformance tests
    pub fn to_error_code(&self) -> &'static str {
        match self {
            StreamError::NotFound { .. } => "NOT_FOUND",
            StreamError::Conflict => "CONFLICT",
            StreamError::SeqConflict => "SEQUENCE_CONFLICT",
            StreamError::OffsetGone { .. } => "INVALID_OFFSET",
            StreamError::BadRequest { .. } => "INVALID_OFFSET",
            StreamError::Unauthorized => "UNAUTHORIZED",
            StreamError::Forbidden => "FORBIDDEN",
            StreamError::ParseError(_) => "PARSE_ERROR",
            _ => "UNEXPECTED_STATUS",
        }
    }
}

impl From<reqwest::Error> for StreamError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            StreamError::Timeout
        } else {
            StreamError::Network(err)
        }
    }
}

#[cfg(feature = "json")]
impl From<serde_json::Error> for StreamError {
    fn from(err: serde_json::Error) -> Self {
        StreamError::Json(err.to_string())
    }
}

/// Producer-specific errors.
#[derive(Debug, Clone, Error)]
pub enum ProducerError {
    #[error("producer is closed")]
    Closed,

    #[error("stale epoch: server has epoch {server_epoch}, we have {our_epoch}")]
    StaleEpoch { server_epoch: u64, our_epoch: u64 },

    #[error("sequence gap: expected {expected}, received {received}")]
    SequenceGap { expected: u64, received: u64 },

    #[error("stream error: {message}")]
    Stream { message: String },

    #[error("mixed append types in JSON mode")]
    MixedAppendTypes,
}

impl From<reqwest::Error> for ProducerError {
    fn from(err: reqwest::Error) -> Self {
        ProducerError::Stream {
            message: StreamError::from(err).to_string(),
        }
    }
}

impl From<StreamError> for ProducerError {
    fn from(err: StreamError) -> Self {
        ProducerError::Stream {
            message: err.to_string(),
        }
    }
}
