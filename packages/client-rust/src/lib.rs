//! Durable Streams Rust Client
//!
//! A Rust client library for the Durable Streams protocol - persistent, resumable
//! event streams over HTTP with exactly-once semantics.
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use durable_streams::{Client, Offset, LiveMode};
//! use futures::StreamExt;
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
//!     let mut reader = stream.read().offset(Offset::Beginning).send().await?;
//!     while let Some(chunk) = reader.next().await {
//!         let chunk = chunk?;
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
pub use error::{ProducerError, StreamError};
pub use iterator::{Chunk, ChunkIterator, ReadBuilder};
pub use producer::{AppendReceipt, IdempotentProducer, ProducerBuilder};
pub use stream::{AppendOptions, AppendResponse, CreateOptions, HeadResponse, Stream};
pub use types::{LiveMode, Offset};

/// Done sentinel - indicates iteration is complete
pub const DONE: &str = "done";
