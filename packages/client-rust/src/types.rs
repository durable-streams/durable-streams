//! Core types for the Durable Streams client.

use std::cmp::Ordering;
use std::fmt;

/// Stream position specification.
///
/// Offsets are:
/// - Opaque: Do not parse or interpret offset structure
/// - Lexicographically sortable: Compare offsets to determine ordering
/// - Persistent: Valid for the stream's lifetime
/// - Unique: Each position has exactly one offset
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Offset {
    /// Start from the beginning of the stream (sentinel "-1")
    Beginning,
    /// Start from the current tail (only future data, sentinel "now")
    Now,
    /// Start from a specific offset token
    At(String),
}

impl Offset {
    /// Create an offset at a specific position.
    ///
    /// This is a convenience constructor for `Offset::At`.
    ///
    /// # Example
    /// ```
    /// use durable_streams::Offset;
    /// let offset = Offset::at("abc123");
    /// ```
    pub fn at(s: impl Into<String>) -> Self {
        Offset::At(s.into())
    }

    /// Parse from protocol string
    pub fn parse(s: &str) -> Self {
        match s {
            "-1" => Offset::Beginning,
            "now" => Offset::Now,
            "" => Offset::Beginning,
            other => Offset::At(other.to_string()),
        }
    }

    /// Convert to query parameter value
    pub fn to_query_value(&self) -> &str {
        match self {
            Offset::Beginning => "-1",
            Offset::Now => "now",
            Offset::At(s) => s.as_str(),
        }
    }

    /// Check if this is the beginning sentinel
    pub fn is_beginning(&self) -> bool {
        matches!(self, Offset::Beginning)
    }

    /// Check if this is the now sentinel
    pub fn is_now(&self) -> bool {
        matches!(self, Offset::Now)
    }

    /// Get the inner string value for At variant
    pub fn as_str(&self) -> &str {
        match self {
            Offset::Beginning => "-1",
            Offset::Now => "now",
            Offset::At(s) => s.as_str(),
        }
    }
}

impl Default for Offset {
    fn default() -> Self {
        Offset::Beginning
    }
}

impl fmt::Display for Offset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_query_value())
    }
}

impl From<String> for Offset {
    fn from(s: String) -> Self {
        Offset::parse(&s)
    }
}

impl From<&str> for Offset {
    fn from(s: &str) -> Self {
        Offset::parse(s)
    }
}

impl PartialOrd for Offset {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Offset::At(a), Offset::At(b)) => Some(a.cmp(b)), // Lexicographic
            (Offset::Beginning, Offset::Beginning) => Some(Ordering::Equal),
            (Offset::Now, Offset::Now) => Some(Ordering::Equal),
            (Offset::Beginning, Offset::At(_)) => Some(Ordering::Less),
            (Offset::At(_), Offset::Beginning) => Some(Ordering::Greater),
            _ => None, // Now is not comparable with other offsets
        }
    }
}

/// Live tailing mode for stream consumption.
///
/// ## `LiveMode::Auto` Fallback Behavior
///
/// When `Auto` is selected:
///
/// 1. **Catch-up first**: Regular HTTP reads until `up_to_date`
/// 2. **SSE after catch-up**: Attempts SSE connection for live tailing
/// 3. **Fallback to long-poll**: If SSE fails (400 or wrong content type)
///
/// The fallback is transparent to the user - iteration continues seamlessly.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum LiveMode {
    /// No live tailing - stop after catching up (first `up_to_date`)
    #[default]
    Off,
    /// Automatic selection: SSE preferred, falls back to long-poll on failure.
    Auto,
    /// Explicit long-polling for live updates
    LongPoll,
    /// Explicit Server-Sent Events for live updates.
    Sse,
}

impl LiveMode {
    /// Convert to query parameter value (if any)
    pub fn to_query_value(&self) -> Option<&str> {
        match self {
            LiveMode::Off => None,
            LiveMode::Auto => Some("sse"), // Try SSE first
            LiveMode::LongPoll => Some("long-poll"),
            LiveMode::Sse => Some("sse"),
        }
    }

    /// Check if this mode involves live tailing
    pub fn is_live(&self) -> bool {
        !matches!(self, LiveMode::Off)
    }
}
