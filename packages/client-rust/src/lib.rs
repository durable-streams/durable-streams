//! Durable Streams Rust Client
//!
//! A Rust client library for the Durable Streams protocol - persistent, resumable
//! event streams over HTTP with exactly-once semantics.
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use durable_streams::{Client, Offset};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = Client::new();
//!     let stream = client.stream("https://api.example.com/streams/my-stream");
//!
//!     // Create a stream
//!     stream.create().await?;
//!
//!     // Append data
//!     stream.append(b"hello world").await?;
//!
//!     // Read data
//!     let mut reader = stream.read().offset(Offset::Beginning).build();
//!     while let Some(chunk) = reader.next_chunk().await? {
//!         println!("Got {} bytes", chunk.data.len());
//!     }
//!
//!     Ok(())
//! }
//! ```

mod client;
mod error;
mod iterator;
mod producer;
mod stream;
mod types;

pub use client::{Client, ClientBuilder};
pub use error::{InvalidHeaderError, ProducerError, StreamError};
pub use iterator::{Chunk, ChunkIterator, ReadBuilder};
pub use producer::{Producer, ProducerBuilder};
pub use stream::{AppendOptions, AppendResponse, CreateOptions, DurableStream, HeadResponse};
pub use types::{LiveMode, Offset};

/// Prelude module for convenient imports.
///
/// # Example
/// ```
/// use durable_streams::prelude::*;
/// ```
///
/// This imports the most commonly used types:
/// - [`Client`] - The main client for connecting to streams
/// - [`Offset`] - Stream position specification
/// - [`LiveMode`] - Live tailing mode configuration
/// - [`StreamError`] - Error type for stream operations
/// - [`Chunk`] - Data chunk from reading a stream
pub mod prelude {
    pub use crate::client::Client;
    pub use crate::error::StreamError;
    pub use crate::iterator::Chunk;
    pub use crate::types::{LiveMode, Offset};
}
