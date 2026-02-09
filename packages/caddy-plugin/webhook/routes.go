package webhook

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// Routes handles webhook-related HTTP requests.
type Routes struct {
	Manager *Manager
}

// NewRoutes creates a new Routes handler.
func NewRoutes(manager *Manager) *Routes {
	return &Routes{Manager: manager}
}

// HandleRequest tries to handle a request as a webhook route.
// Returns true if the request was handled, false if it should be passed through.
func (rt *Routes) HandleRequest(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path

	// Check for callback routes: /callback/{consumer_id}
	if strings.HasPrefix(path, "/callback/") {
		rt.handleCallback(w, r, path)
		return true
	}

	// Check for subscription query parameters
	query := r.URL.Query()
	_, hasSubscription := query["subscription"]
	_, hasSubscriptions := query["subscriptions"]

	if !hasSubscription && !hasSubscriptions {
		return false
	}

	if hasSubscription {
		subscriptionID := query.Get("subscription")

		switch r.Method {
		case http.MethodPut:
			rt.handleCreateSubscription(w, r, path, subscriptionID)
			return true
		case http.MethodGet:
			rt.handleGetSubscription(w, subscriptionID)
			return true
		case http.MethodDelete:
			rt.handleDeleteSubscription(w, subscriptionID)
			return true
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return true
		}
	}

	if hasSubscriptions && r.Method == http.MethodGet {
		rt.handleListSubscriptions(w, path)
		return true
	}

	return false
}

func (rt *Routes) handleCreateSubscription(w http.ResponseWriter, r *http.Request, pattern, subscriptionID string, ) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	var parsed struct {
		Webhook     string `json:"webhook"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if parsed.Webhook == "" {
		http.Error(w, "Missing required field: webhook", http.StatusBadRequest)
		return
	}

	sub, created, err := rt.Manager.Store.CreateSubscription(
		subscriptionID, pattern, parsed.Webhook, parsed.Description,
	)
	if err != nil {
		if strings.Contains(err.Error(), "different configuration") {
			http.Error(w, "Subscription already exists with different configuration", http.StatusConflict)
			return
		}
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	resp := map[string]interface{}{
		"subscription_id": sub.SubscriptionID,
		"pattern":         sub.Pattern,
		"webhook":         sub.Webhook,
	}
	if sub.Description != "" {
		resp["description"] = sub.Description
	}
	if created {
		resp["webhook_secret"] = sub.WebhookSecret
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(resp)
}

func (rt *Routes) handleGetSubscription(w http.ResponseWriter, subscriptionID string) {
	sub := rt.Manager.Store.GetSubscription(subscriptionID)
	if sub == nil {
		http.Error(w, "Subscription not found", http.StatusNotFound)
		return
	}

	resp := map[string]interface{}{
		"subscription_id": sub.SubscriptionID,
		"pattern":         sub.Pattern,
		"webhook":         sub.Webhook,
	}
	if sub.Description != "" {
		resp["description"] = sub.Description
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (rt *Routes) handleDeleteSubscription(w http.ResponseWriter, subscriptionID string) {
	rt.Manager.Store.DeleteSubscription(subscriptionID)
	w.WriteHeader(http.StatusNoContent)
}

func (rt *Routes) handleListSubscriptions(w http.ResponseWriter, pattern string) {
	subs := rt.Manager.Store.ListSubscriptions(pattern)

	items := make([]map[string]interface{}, 0, len(subs))
	for _, sub := range subs {
		item := map[string]interface{}{
			"subscription_id": sub.SubscriptionID,
			"pattern":         sub.Pattern,
			"webhook":         sub.Webhook,
		}
		if sub.Description != "" {
			item["description"] = sub.Description
		}
		items = append(items, item)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"subscriptions": items,
	})
}

func (rt *Routes) handleCallback(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract consumer ID from /callback/{consumer_id}
	consumerID := path[len("/callback/"):]

	// Extract token from Authorization header
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeTokenInvalid,
				Message: "Missing or malformed Authorization header",
			},
		})
		return
	}
	token := authHeader[len("Bearer "):]

	// Parse request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeInvalidRequest,
				Message: "Failed to read request body",
			},
		})
		return
	}

	// Parse into a raw map first to check for epoch presence
	var rawParsed map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawParsed); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeInvalidRequest,
				Message: "Invalid JSON body",
			},
		})
		return
	}

	if _, hasEpoch := rawParsed["epoch"]; !hasEpoch {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeInvalidRequest,
				Message: "Missing required field: epoch",
			},
		})
		return
	}

	var request CallbackRequest
	if err := json.Unmarshal(body, &request); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(CallbackErrorResponse{
			OK: false,
			Error: CallbackErrObj{
				Code:    ErrCodeInvalidRequest,
				Message: "Invalid JSON body",
			},
		})
		return
	}

	result := rt.Manager.HandleCallback(consumerID, token, request)

	w.Header().Set("Content-Type", "application/json")

	switch r := result.(type) {
	case CallbackSuccess:
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(r)
	case CallbackErrorResponse:
		status, ok := ErrorCodeToHTTPStatus[r.Error.Code]
		if !ok {
			status = http.StatusInternalServerError
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(r)
	}
}
