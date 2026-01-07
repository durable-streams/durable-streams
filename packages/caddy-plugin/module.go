package durablestreams

import (
	"fmt"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"github.com/durable-streams/durable-streams/packages/caddy-plugin/store"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(Handler{})
	httpcaddyfile.RegisterHandlerDirective("durable_streams", parseCaddyfile)
}

// Handler implements the Durable Streams Protocol as a Caddy HTTP handler
type Handler struct {
	// DataDir is the directory for storing stream data
	// If empty, uses in-memory storage (for testing)
	DataDir string `json:"data_dir,omitempty"`

	// MaxFileHandles is the maximum number of open file handles to cache
	MaxFileHandles int `json:"max_file_handles,omitempty"`

	// LongPollTimeout is the default timeout for long-poll requests
	LongPollTimeout caddy.Duration `json:"long_poll_timeout,omitempty"`

	// SSEReconnectInterval is how often SSE connections should reconnect
	SSEReconnectInterval caddy.Duration `json:"sse_reconnect_interval,omitempty"`

	store  store.Store
	logger *zap.Logger
}

// CaddyModule returns the Caddy module information
func (Handler) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.durable_streams",
		New: func() caddy.Module { return new(Handler) },
	}
}

// Provision sets up the handler
func (h *Handler) Provision(ctx caddy.Context) error {
	h.logger = ctx.Logger()

	// Set defaults
	if h.MaxFileHandles == 0 {
		h.MaxFileHandles = 100
	}
	if h.LongPollTimeout == 0 {
		h.LongPollTimeout = caddy.Duration(30 * time.Second)
	}
	if h.SSEReconnectInterval == 0 {
		h.SSEReconnectInterval = caddy.Duration(60 * time.Second)
	}

	// Initialize store
	if h.DataDir == "" {
		// Use in-memory store for testing
		h.store = store.NewMemoryStore()
		h.logger.Info("using in-memory store (no data_dir configured)")
	} else {
		// Use file-backed store
		fileStore, err := store.NewFileStore(store.FileStoreConfig{
			DataDir:        h.DataDir,
			MaxFileHandles: h.MaxFileHandles,
		})
		if err != nil {
			return fmt.Errorf("failed to initialize file store: %w", err)
		}
		h.store = fileStore
		h.logger.Info("using file-backed store", zap.String("data_dir", h.DataDir))
	}

	return nil
}

// Validate ensures the handler configuration is valid
func (h *Handler) Validate() error {
	return nil
}

// Cleanup releases resources
func (h *Handler) Cleanup() error {
	if h.store != nil {
		return h.store.Close()
	}
	return nil
}

// UnmarshalCaddyfile parses the Caddyfile syntax for durable_streams
//
//	durable_streams {
//	    data_dir /var/lib/durable-streams
//	    max_file_handles 100
//	    long_poll_timeout 30s
//	    sse_reconnect_interval 60s
//	}
func (h *Handler) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	for d.Next() {
		for d.NextBlock(0) {
			switch d.Val() {
			case "data_dir":
				if !d.Args(&h.DataDir) {
					return d.ArgErr()
				}
			case "max_file_handles":
				var val string
				if !d.Args(&val) {
					return d.ArgErr()
				}
				var err error
				h.MaxFileHandles, err = parseIntArg(val)
				if err != nil {
					return d.Errf("invalid max_file_handles: %v", err)
				}
			case "long_poll_timeout":
				var val string
				if !d.Args(&val) {
					return d.ArgErr()
				}
				dur, err := caddy.ParseDuration(val)
				if err != nil {
					return d.Errf("invalid duration: %v", err)
				}
				h.LongPollTimeout = caddy.Duration(dur)
			case "sse_reconnect_interval":
				var val string
				if !d.Args(&val) {
					return d.ArgErr()
				}
				dur, err := caddy.ParseDuration(val)
				if err != nil {
					return d.Errf("invalid duration: %v", err)
				}
				h.SSEReconnectInterval = caddy.Duration(dur)
			default:
				return d.Errf("unknown subdirective: %s", d.Val())
			}
		}
	}
	return nil
}

func parseCaddyfile(h httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	var handler Handler
	err := handler.UnmarshalCaddyfile(h.Dispenser)
	return &handler, err
}

func parseIntArg(s string) (int, error) {
	var val int
	_, err := fmt.Sscanf(s, "%d", &val)
	return val, err
}

// Interface guards
var (
	_ caddy.Provisioner           = (*Handler)(nil)
	_ caddy.Validator             = (*Handler)(nil)
	_ caddy.CleanerUpper          = (*Handler)(nil)
	_ caddyhttp.MiddlewareHandler = (*Handler)(nil)
	_ caddyfile.Unmarshaler       = (*Handler)(nil)
)
