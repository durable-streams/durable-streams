package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
)

const (
	livenessTimeoutMS      = 45_000
	webhookRequestTimeout  = 30 * time.Second
	maxRetryDelayMS        = 30_000
	steadyRetryDelayMS     = 60_000
	gcFailureDuration      = 3 * 24 * time.Hour // 3 days
)

// Manager orchestrates webhook delivery, consumer lifecycle, and callbacks.
type Manager struct {
	Store          *Store
	callbackBaseURL string
	getTailOffset  func(path string) string
	client         *http.Client
	logger         *zap.Logger

	mu            sync.Mutex
	shuttingDown  bool
}

// NewManager creates a new webhook Manager.
func NewManager(callbackBaseURL string, getTailOffset func(string) string, logger *zap.Logger) *Manager {
	return &Manager{
		Store:           NewStore(),
		callbackBaseURL: callbackBaseURL,
		getTailOffset:   getTailOffset,
		client: &http.Client{
			Timeout: webhookRequestTimeout,
		},
		logger: logger,
	}
}

// OnStreamAppend is called when events are appended to a stream.
func (m *Manager) OnStreamAppend(streamPath string) {
	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	consumerIDs := m.Store.GetConsumersForStream(streamPath)
	for _, cid := range consumerIDs {
		consumer := m.Store.GetConsumer(cid)
		if consumer == nil {
			continue
		}

		if consumer.State == StateIDLE {
			if m.Store.HasPendingWork(consumer, m.getTailOffset) {
				m.wakeConsumer(consumer, []string{streamPath})
			}
		}
	}
}

// OnStreamCreated is called when a new stream is created.
func (m *Manager) OnStreamCreated(streamPath string) {
	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	matchingSubs := m.Store.FindMatchingSubscriptions(streamPath)
	for _, sub := range matchingSubs {
		m.Store.GetOrCreateConsumer(sub.SubscriptionID, streamPath)
	}
}

// OnStreamDeleted is called when a stream is deleted.
func (m *Manager) OnStreamDeleted(streamPath string) {
	m.Store.RemoveStreamFromConsumers(streamPath)
}

func (m *Manager) wakeConsumer(consumer *ConsumerInstance, triggeredBy []string) {
	sub := m.Store.GetSubscription(consumer.SubscriptionID)
	if sub == nil {
		m.Store.RemoveConsumer(consumer.ConsumerID)
		return
	}

	epoch, wakeID := m.Store.TransitionToWaking(consumer)

	callbackURL := m.buildCallbackURL(consumer.ConsumerID)
	token := GenerateCallbackToken(consumer.ConsumerID, epoch)

	payload := map[string]interface{}{
		"consumer_id":    consumer.ConsumerID,
		"epoch":          epoch,
		"wake_id":        wakeID,
		"primary_stream": consumer.PrimaryStream,
		"streams":        m.Store.GetStreamsData(consumer),
		"triggered_by":   triggeredBy,
		"callback":       callbackURL,
		"token":          token,
	}

	go m.deliverWebhook(consumer, sub, payload)
}

func (m *Manager) deliverWebhook(consumer *ConsumerInstance, sub *Subscription, payload map[string]interface{}) {
	body, _ := json.Marshal(payload)
	signature := SignWebhookPayload(string(body), sub.WebhookSecret)

	req, err := http.NewRequest("POST", sub.Webhook, bytes.NewReader(body))
	if err != nil {
		m.handleDeliveryError(consumer, sub, payload, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Webhook-Signature", signature)

	resp, err := m.client.Do(req)
	if err != nil {
		m.handleDeliveryError(consumer, sub, payload, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		consumer.LastWebhookFailureAt = nil
		consumer.FirstWebhookFailureAt = nil
		consumer.RetryCount = 0

		var resBody struct {
			Done *bool `json:"done"`
		}
		respBytes, _ := io.ReadAll(resp.Body)
		json.Unmarshal(respBytes, &resBody)

		if resBody.Done != nil && *resBody.Done {
			consumer.WakeIDClaimed = true
			for path := range consumer.Streams {
				tail := m.getTailOffset(path)
				consumer.Streams[path] = tail
			}
			m.Store.TransitionToIdle(consumer)
			return
		}

		if consumer.State == StateWAKING {
			consumer.WakeIDClaimed = true
			consumer.State = StateLIVE
			consumer.LastCallbackAt = time.Now()
			m.resetLivenessTimeout(consumer)
		}
		return
	}

	// Non-2xx — schedule retry if still in WAKING and unclaimed
	if !consumer.WakeIDClaimed && consumer.State == StateWAKING {
		m.scheduleRetry(consumer, sub, payload)
	}
}

func (m *Manager) handleDeliveryError(consumer *ConsumerInstance, sub *Subscription, payload map[string]interface{}, err error) {
	m.logger.Debug("webhook delivery failed",
		zap.String("consumer_id", consumer.ConsumerID),
		zap.Error(err))

	now := time.Now()
	consumer.LastWebhookFailureAt = &now
	if consumer.FirstWebhookFailureAt == nil {
		consumer.FirstWebhookFailureAt = &now
	}

	if consumer.FirstWebhookFailureAt != nil && time.Since(*consumer.FirstWebhookFailureAt) > gcFailureDuration {
		m.Store.RemoveConsumer(consumer.ConsumerID)
		return
	}

	if consumer.State == StateWAKING {
		m.scheduleRetry(consumer, sub, payload)
	}
}

func (m *Manager) scheduleRetry(consumer *ConsumerInstance, sub *Subscription, payload map[string]interface{}) {
	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	consumer.RetryCount++
	delay := m.calculateRetryDelay(consumer.RetryCount)

	consumer.CancelRetry()
	cancel := make(chan struct{})
	consumer.retryCancel = cancel

	go func() {
		timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
		defer timer.Stop()

		select {
		case <-timer.C:
			if consumer.State == StateWAKING && !consumer.WakeIDClaimed && !m.isShuttingDown() {
				m.deliverWebhook(consumer, sub, payload)
			}
		case <-cancel:
			return
		}
	}()
}

func (m *Manager) calculateRetryDelay(retryCount int) int {
	if retryCount > 10 {
		return steadyRetryDelayMS + rand.Intn(5000)
	}
	base := int(math.Min(math.Pow(2, float64(retryCount))*100, float64(maxRetryDelayMS)))
	return base + rand.Intn(1000)
}

// HandleCallback processes a callback request from a consumer.
func (m *Manager) HandleCallback(consumerID, token string, request CallbackRequest) interface{} {
	consumer := m.Store.GetConsumer(consumerID)
	if consumer == nil {
		return CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeConsumerGone,
				Message: "Consumer instance not found",
			},
		}
	}

	// Validate token
	tokenResult := ValidateCallbackToken(token, consumerID)
	if !tokenResult.Valid {
		if tokenResult.Code == ErrCodeTokenExpired {
			newToken := GenerateCallbackToken(consumerID, consumer.Epoch)
			return CallbackErrorResponse{
				OK: false,
				Error: CallbackErrObj{
					Code:    ErrCodeTokenExpired,
					Message: "Callback token has expired",
				},
				Token: newToken,
			}
		}
		return CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeTokenInvalid,
				Message: "Callback token is invalid",
			},
		}
	}

	// Validate epoch
	if request.Epoch != consumer.Epoch {
		newToken := GenerateCallbackToken(consumerID, consumer.Epoch)
		return CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeStaleEpoch,
				Message: fmt.Sprintf("Consumer epoch %d does not match current epoch %d", request.Epoch, consumer.Epoch),
			},
			Token: newToken,
		}
	}

	// Handle wake_id claim
	if request.WakeID != "" {
		if !m.Store.ClaimWakeID(consumer, request.WakeID) {
			newToken := GenerateCallbackToken(consumerID, consumer.Epoch)
			return CallbackErrorResponse{
				OK: false,
				Error: CallbackErrObj{
					Code:    ErrCodeAlreadyClaimed,
					Message: fmt.Sprintf("Wake ID %s is invalid or already claimed", request.WakeID),
				},
				Token: newToken,
			}
		}
	}

	// Reset liveness timeout
	consumer.LastCallbackAt = time.Now()
	m.resetLivenessTimeout(consumer)

	// Process acks
	if len(request.Acks) > 0 {
		m.Store.UpdateAcks(consumer, request.Acks)
	}

	// Process subscribes
	if len(request.Subscribe) > 0 {
		m.Store.SubscribeStreams(consumer, request.Subscribe, m.getTailOffset)
	}

	// Process unsubscribes
	if len(request.Unsubscribe) > 0 {
		shouldRemove := m.Store.UnsubscribeStreams(consumer, request.Unsubscribe)
		if shouldRemove {
			m.Store.RemoveConsumer(consumerID)
			return CallbackErrorResponse{
				OK: false,
				Error: CallbackErrObj{
					Code:    ErrCodeConsumerGone,
					Message: "Consumer removed after unsubscribing from all streams",
				},
			}
		}
	}

	// Process done
	if request.Done != nil && *request.Done {
		if m.Store.HasPendingWork(consumer, m.getTailOffset) {
			m.Store.TransitionToIdle(consumer)
			m.wakeConsumer(consumer, []string{consumer.PrimaryStream})
		} else {
			m.Store.TransitionToIdle(consumer)
		}
	}

	// Token refresh: only generate new token if current one is nearing expiry
	responseToken := token
	if TokenNeedsRefresh(tokenResult.Exp) {
		responseToken = GenerateCallbackToken(consumerID, consumer.Epoch)
	}

	return CallbackSuccess{
		OK:      true,
		Token:   responseToken,
		Streams: m.Store.GetStreamsData(consumer),
	}
}

func (m *Manager) resetLivenessTimeout(consumer *ConsumerInstance) {
	consumer.CancelLiveness()

	cancel := make(chan struct{})
	consumer.livenessCancel = cancel

	go func() {
		timer := time.NewTimer(time.Duration(livenessTimeoutMS) * time.Millisecond)
		defer timer.Stop()

		select {
		case <-timer.C:
			if consumer.State == StateLIVE && !m.isShuttingDown() {
				m.Store.TransitionToIdle(consumer)
				if m.Store.HasPendingWork(consumer, m.getTailOffset) {
					m.wakeConsumer(consumer, []string{consumer.PrimaryStream})
				}
			}
		case <-cancel:
			return
		}
	}()
}

func (m *Manager) buildCallbackURL(consumerID string) string {
	return m.callbackBaseURL + "/callback/" + consumerID
}

func (m *Manager) isShuttingDown() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.shuttingDown
}

// Shutdown stops the manager and cancels all timers.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.shuttingDown = true
	m.mu.Unlock()
	m.Store.Shutdown()
}
