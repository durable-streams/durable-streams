package webhook

import (
	"fmt"
	"net/url"
	"sync"
	"time"
)

// Store manages in-memory state for webhook subscriptions and consumers.
type Store struct {
	mu sync.RWMutex

	subscriptions         map[string]*Subscription    // subscription_id -> Subscription
	consumers             map[string]*ConsumerInstance // consumer_id -> ConsumerInstance
	subscriptionConsumers map[string]map[string]bool   // subscription_id -> set of consumer_ids
	streamConsumers       map[string]map[string]bool   // stream_path -> set of consumer_ids
}

// NewStore creates a new webhook Store.
func NewStore() *Store {
	return &Store{
		subscriptions:         make(map[string]*Subscription),
		consumers:             make(map[string]*ConsumerInstance),
		subscriptionConsumers: make(map[string]map[string]bool),
		streamConsumers:       make(map[string]map[string]bool),
	}
}

// CreateSubscription creates or idempotently returns a subscription.
// Returns the subscription, whether it was newly created, and any error.
func (s *Store) CreateSubscription(subscriptionID, pattern, webhook string, description string) (*Subscription, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.subscriptions[subscriptionID]; ok {
		if existing.Pattern == pattern && existing.Webhook == webhook {
			return existing, false, nil
		}
		return nil, false, fmt.Errorf("subscription already exists with different configuration")
	}

	sub := &Subscription{
		SubscriptionID: subscriptionID,
		Pattern:        pattern,
		Webhook:        webhook,
		WebhookSecret:  GenerateWebhookSecret(),
		Description:    description,
	}

	s.subscriptions[subscriptionID] = sub
	s.subscriptionConsumers[subscriptionID] = make(map[string]bool)
	return sub, true, nil
}

// GetSubscription returns a subscription by ID, or nil if not found.
func (s *Store) GetSubscription(subscriptionID string) *Subscription {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.subscriptions[subscriptionID]
}

// ListSubscriptions returns all subscriptions, optionally filtered by pattern.
func (s *Store) ListSubscriptions(pattern string) []*Subscription {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*Subscription
	for _, sub := range s.subscriptions {
		if pattern == "" || pattern == "/**" || sub.Pattern == pattern {
			result = append(result, sub)
		}
	}
	return result
}

// DeleteSubscription removes a subscription and all its consumers.
func (s *Store) DeleteSubscription(subscriptionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.subscriptions[subscriptionID]; !ok {
		return false
	}

	if consumerIDs, ok := s.subscriptionConsumers[subscriptionID]; ok {
		for cid := range consumerIDs {
			s.removeConsumerLocked(cid)
		}
	}

	delete(s.subscriptionConsumers, subscriptionID)
	delete(s.subscriptions, subscriptionID)
	return true
}

// FindMatchingSubscriptions returns subscriptions whose pattern matches a stream path.
func (s *Store) FindMatchingSubscriptions(streamPath string) []*Subscription {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var result []*Subscription
	for _, sub := range s.subscriptions {
		if GlobMatch(sub.Pattern, streamPath) {
			result = append(result, sub)
		}
	}
	return result
}

// BuildConsumerID builds a consumer ID from subscription ID and stream path.
func BuildConsumerID(subscriptionID, streamPath string) string {
	return subscriptionID + ":" + url.PathEscape(streamPath)
}

// GetConsumer returns a consumer by ID, or nil if not found.
func (s *Store) GetConsumer(consumerID string) *ConsumerInstance {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.consumers[consumerID]
}

// GetOrCreateConsumer returns (or creates) a consumer for a subscription + stream pair.
func (s *Store) GetOrCreateConsumer(subscriptionID, streamPath string) *ConsumerInstance {
	s.mu.Lock()
	defer s.mu.Unlock()

	consumerID := BuildConsumerID(subscriptionID, streamPath)
	if c, ok := s.consumers[consumerID]; ok {
		return c
	}

	c := &ConsumerInstance{
		ConsumerID:     consumerID,
		SubscriptionID: subscriptionID,
		PrimaryStream:  streamPath,
		State:          StateIDLE,
		Epoch:          0,
		Streams:        map[string]string{streamPath: "-1"},
	}

	s.consumers[consumerID] = c

	if subConsumers, ok := s.subscriptionConsumers[subscriptionID]; ok {
		subConsumers[consumerID] = true
	}
	s.addStreamIndex(streamPath, consumerID)

	return c
}

// TransitionToWaking moves a consumer from IDLE to WAKING, incrementing epoch.
func (s *Store) TransitionToWaking(c *ConsumerInstance) (epoch int, wakeID string) {
	c.Epoch++
	c.WakeID = GenerateWakeID()
	c.WakeIDClaimed = false
	c.State = StateWAKING
	return c.Epoch, c.WakeID
}

// ClaimWakeID claims a wake_id. Returns true on success or if already claimed (idempotent).
func (s *Store) ClaimWakeID(c *ConsumerInstance, wakeID string) bool {
	if c.WakeID != wakeID {
		return false
	}
	if c.WakeIDClaimed {
		return true
	}
	c.WakeIDClaimed = true
	c.State = StateLIVE
	c.LastCallbackAt = time.Now()
	return true
}

// TransitionToIdle moves a consumer to IDLE and cancels timers.
func (s *Store) TransitionToIdle(c *ConsumerInstance) {
	c.State = StateIDLE
	c.WakeID = ""
	c.WakeIDClaimed = false
	c.CancelLiveness()
}

// UpdateAcks updates acked offsets for a consumer.
func (s *Store) UpdateAcks(c *ConsumerInstance, acks []AckEntry) {
	for _, ack := range acks {
		if _, ok := c.Streams[ack.Path]; ok {
			c.Streams[ack.Path] = ack.Offset
		}
	}
}

// SubscribeStreams subscribes a consumer to additional streams.
func (s *Store) SubscribeStreams(c *ConsumerInstance, paths []string, getTailOffset func(string) string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, path := range paths {
		if _, ok := c.Streams[path]; !ok {
			tail := getTailOffset(path)
			c.Streams[path] = tail
			s.addStreamIndex(path, c.ConsumerID)
		}
	}
}

// UnsubscribeStreams unsubscribes a consumer from streams.
// Returns true if the consumer has no streams left and should be removed.
func (s *Store) UnsubscribeStreams(c *ConsumerInstance, paths []string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, path := range paths {
		delete(c.Streams, path)
		s.removeStreamIndex(path, c.ConsumerID)
	}
	return len(c.Streams) == 0
}

// HasPendingWork checks if a consumer has unprocessed events.
func (s *Store) HasPendingWork(c *ConsumerInstance, getTailOffset func(string) string) bool {
	for path, ackedOffset := range c.Streams {
		tail := getTailOffset(path)
		if tail > ackedOffset {
			return true
		}
	}
	return false
}

// GetStreamsData returns the consumer's streams as a slice.
func (s *Store) GetStreamsData(c *ConsumerInstance) []StreamEntry {
	result := make([]StreamEntry, 0, len(c.Streams))
	for path, offset := range c.Streams {
		result = append(result, StreamEntry{Path: path, Offset: offset})
	}
	return result
}

// GetConsumersForStream returns consumer IDs subscribed to a stream.
func (s *Store) GetConsumersForStream(streamPath string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	set := s.streamConsumers[streamPath]
	result := make([]string, 0, len(set))
	for cid := range set {
		result = append(result, cid)
	}
	return result
}

// RemoveConsumer removes a consumer and cleans up all indexes.
func (s *Store) RemoveConsumer(consumerID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeConsumerLocked(consumerID)
}

func (s *Store) removeConsumerLocked(consumerID string) {
	c, ok := s.consumers[consumerID]
	if !ok {
		return
	}

	c.CancelRetry()
	c.CancelLiveness()

	for path := range c.Streams {
		s.removeStreamIndex(path, consumerID)
	}

	if subConsumers, ok := s.subscriptionConsumers[c.SubscriptionID]; ok {
		delete(subConsumers, consumerID)
	}

	delete(s.consumers, consumerID)
}

// RemoveStreamFromConsumers removes a stream from all consumers.
// Consumers with no remaining streams are garbage collected.
func (s *Store) RemoveStreamFromConsumers(streamPath string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	set := s.streamConsumers[streamPath]
	var toRemove []string

	for cid := range set {
		c, ok := s.consumers[cid]
		if !ok {
			continue
		}
		delete(c.Streams, streamPath)
		if len(c.Streams) == 0 {
			toRemove = append(toRemove, cid)
		}
	}

	delete(s.streamConsumers, streamPath)

	for _, cid := range toRemove {
		s.removeConsumerLocked(cid)
	}
}

// Shutdown clears all state and cancels all timers.
func (s *Store) Shutdown() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, c := range s.consumers {
		c.CancelRetry()
		c.CancelLiveness()
	}

	s.consumers = make(map[string]*ConsumerInstance)
	s.subscriptions = make(map[string]*Subscription)
	s.subscriptionConsumers = make(map[string]map[string]bool)
	s.streamConsumers = make(map[string]map[string]bool)
}

func (s *Store) addStreamIndex(streamPath, consumerID string) {
	set, ok := s.streamConsumers[streamPath]
	if !ok {
		set = make(map[string]bool)
		s.streamConsumers[streamPath] = set
	}
	set[consumerID] = true
}

func (s *Store) removeStreamIndex(streamPath, consumerID string) {
	set, ok := s.streamConsumers[streamPath]
	if !ok {
		return
	}
	delete(set, consumerID)
	if len(set) == 0 {
		delete(s.streamConsumers, streamPath)
	}
}
