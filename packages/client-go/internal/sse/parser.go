// Package sse provides Server-Sent Events parsing for the durable streams protocol.
//
// SSE format from protocol:
//   - `event: data` events contain the stream data
//   - `event: control` events contain `streamNextOffset` and optional `streamCursor` and `upToDate`
package sse

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// ErrInvalidControlEvent is returned when a control event cannot be parsed as JSON.
var ErrInvalidControlEvent = errors.New("sse: invalid control event JSON")

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
// Returns ErrInvalidControlEvent if a control event cannot be parsed.
func (p *Parser) Next() (Event, error) {
	for {
		line, err := p.reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				// Try to flush any remaining event
				event, flushErr := p.flushEvent()
				if flushErr != nil {
					return nil, flushErr
				}
				if event != nil {
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
			event, flushErr := p.flushEvent()
			if flushErr != nil {
				return nil, flushErr
			}
			if event != nil {
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
// Returns an error if a control event cannot be parsed as JSON.
func (p *Parser) flushEvent() (Event, error) {
	eventType := p.current.eventType

	// For non-control events, require data
	if eventType == "" {
		p.current.eventType = ""
		p.current.dataLines = nil
		return nil, nil
	}

	// For data events, skip if no data
	if eventType == "data" && len(p.current.dataLines) == 0 {
		p.current.eventType = ""
		p.current.dataLines = nil
		return nil, nil
	}

	dataStr := strings.Join(p.current.dataLines, "\n")

	// Reset state
	p.current.eventType = ""
	p.current.dataLines = nil

	switch eventType {
	case "data":
		return DataEvent{Data: dataStr}, nil
	case "control":
		// Control events must be valid JSON - return error if not
		var control ControlEvent
		if err := json.Unmarshal([]byte(dataStr), &control); err != nil {
			preview := dataStr
			if len(preview) > 100 {
				preview = preview[:100] + "..."
			}
			return nil, fmt.Errorf("%w: %v. Data: %s", ErrInvalidControlEvent, err, preview)
		}
		return control, nil
	default:
		// Unknown event type, skip (per protocol spec)
		return nil, nil
	}
}
