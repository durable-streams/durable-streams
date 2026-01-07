// Package sse provides Server-Sent Events parsing for the durable streams protocol.
//
// SSE format from protocol:
//   - `event: data` events contain the stream data
//   - `event: control` events contain `streamNextOffset` and optional `streamCursor` and `upToDate`
package sse

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

// Event represents a parsed SSE event.
type Event interface {
	eventType() string
}

// DataEvent contains stream data from an SSE `data` event.
type DataEvent struct {
	Data string
}

func (DataEvent) eventType() string { return "data" }

// ControlEvent contains metadata from an SSE `control` event.
type ControlEvent struct {
	StreamNextOffset string `json:"streamNextOffset"`
	StreamCursor     string `json:"streamCursor,omitempty"`
	UpToDate         bool   `json:"upToDate,omitempty"`
}

func (ControlEvent) eventType() string { return "control" }

// Parser parses SSE events from an io.Reader.
type Parser struct {
	reader  *bufio.Reader
	current struct {
		eventType string
		dataLines []string
	}
}

// NewParser creates a new SSE parser from an io.Reader.
func NewParser(r io.Reader) *Parser {
	return &Parser{
		reader: bufio.NewReader(r),
	}
}

// Next returns the next SSE event.
// Returns io.EOF when the stream is exhausted.
func (p *Parser) Next() (Event, error) {
	for {
		line, err := p.reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				// Try to flush any remaining event
				if event := p.flushEvent(); event != nil {
					return event, nil
				}
			}
			return nil, err
		}

		// Remove trailing newline
		line = strings.TrimSuffix(line, "\n")
		line = strings.TrimSuffix(line, "\r")

		if line == "" {
			// Empty line signals end of event
			if event := p.flushEvent(); event != nil {
				return event, nil
			}
			continue
		}

		if strings.HasPrefix(line, "event:") {
			p.current.eventType = strings.TrimSpace(line[6:])
		} else if strings.HasPrefix(line, "data:") {
			// Per SSE spec, strip the optional space after "data:"
			content := line[5:]
			if strings.HasPrefix(content, " ") {
				content = content[1:]
			}
			p.current.dataLines = append(p.current.dataLines, content)
		}
		// Ignore other fields (id:, retry:, comments starting with :)
	}
}

// flushEvent returns the current event if valid, and resets state.
func (p *Parser) flushEvent() Event {
	if p.current.eventType == "" || len(p.current.dataLines) == 0 {
		p.current.eventType = ""
		p.current.dataLines = nil
		return nil
	}

	dataStr := strings.Join(p.current.dataLines, "\n")
	eventType := p.current.eventType

	// Reset state
	p.current.eventType = ""
	p.current.dataLines = nil

	switch eventType {
	case "data":
		return DataEvent{Data: dataStr}
	case "control":
		var control ControlEvent
		if err := json.Unmarshal([]byte(dataStr), &control); err != nil {
			// Invalid control event, skip
			return nil
		}
		return control
	default:
		// Unknown event type, skip
		return nil
	}
}
