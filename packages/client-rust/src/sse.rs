//! Server-Sent Events (SSE) parser.

use std::io::{BufRead, BufReader, Read};

/// SSE event types
#[derive(Debug, Clone)]
pub enum SseEvent {
    /// Data event with payload
    Data(String),
    /// Control event with metadata
    Control {
        stream_next_offset: String,
        stream_cursor: Option<String>,
        up_to_date: bool,
    },
}

/// SSE parser for reading event streams.
pub struct SseParser<R: Read> {
    reader: BufReader<R>,
    buffer: String,
    event_type: Option<String>,
    data_lines: Vec<String>,
}

impl<R: Read> SseParser<R> {
    /// Create a new SSE parser.
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            buffer: String::new(),
            event_type: None,
            data_lines: Vec::new(),
        }
    }

    /// Read the next SSE event.
    pub fn next(&mut self) -> std::io::Result<Option<SseEvent>> {
        loop {
            self.buffer.clear();
            let bytes_read = self.reader.read_line(&mut self.buffer)?;

            if bytes_read == 0 {
                // EOF
                return Ok(None);
            }

            let line = self.buffer.trim_end_matches(&['\r', '\n'][..]);

            if line.is_empty() {
                // Empty line = event dispatch
                if let Some(event) = self.dispatch_event() {
                    return Ok(Some(event));
                }
                continue;
            }

            // Parse field
            if let Some(rest) = line.strip_prefix("event:") {
                self.event_type = Some(rest.trim_start().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data_lines.push(rest.trim_start().to_string());
            }
            // Ignore other fields (id:, retry:, comments starting with :)
        }
    }

    /// Dispatch the current buffered event.
    fn dispatch_event(&mut self) -> Option<SseEvent> {
        if self.data_lines.is_empty() {
            self.event_type = None;
            return None;
        }

        let data = self.data_lines.join("\n");
        let event_type = self.event_type.take();

        self.data_lines.clear();

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

                    Some(SseEvent::Control {
                        stream_next_offset,
                        stream_cursor,
                        up_to_date,
                    })
                } else {
                    None
                }
            }
            _ => {
                // Default is data event
                Some(SseEvent::Data(data))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_parse_data_event() {
        let input = "data: hello world\n\n";
        let mut parser = SseParser::new(Cursor::new(input));

        let event = parser.next().unwrap().unwrap();
        match event {
            SseEvent::Data(data) => assert_eq!(data, "hello world"),
            _ => panic!("Expected data event"),
        }
    }

    #[test]
    fn test_parse_control_event() {
        let input = r#"event: control
data: {"streamNextOffset":"123","upToDate":true}

"#;
        let mut parser = SseParser::new(Cursor::new(input));

        let event = parser.next().unwrap().unwrap();
        match event {
            SseEvent::Control {
                stream_next_offset,
                up_to_date,
                ..
            } => {
                assert_eq!(stream_next_offset, "123");
                assert!(up_to_date);
            }
            _ => panic!("Expected control event"),
        }
    }
}
