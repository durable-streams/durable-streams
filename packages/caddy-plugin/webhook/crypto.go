package webhook

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// tokenKey is generated once per process for signing callback tokens.
var tokenKey []byte

func init() {
	tokenKey = make([]byte, 32)
	if _, err := rand.Read(tokenKey); err != nil {
		panic(fmt.Sprintf("failed to generate token key: %v", err))
	}
}

const tokenRefreshThreshold = 300 // 5 minutes in seconds

// GenerateWebhookSecret creates a new webhook secret prefixed with "whsec_".
func GenerateWebhookSecret() string {
	b := make([]byte, 32)
	rand.Read(b)
	return "whsec_" + hex.EncodeToString(b)
}

// GenerateWakeID creates a unique wake ID prefixed with "w_".
func GenerateWakeID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "w_" + hex.EncodeToString(b)
}

// SignWebhookPayload signs a webhook body with the secret.
// Returns "t=<unix_ts>,sha256=<hex_sig>".
func SignWebhookPayload(body, secret string) string {
	timestamp := time.Now().Unix()
	payload := fmt.Sprintf("%d.%s", timestamp, body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%d,sha256=%s", timestamp, sig)
}

// tokenPayload is the internal structure of a callback token.
type tokenPayload struct {
	Sub   string `json:"sub"`
	Epoch int    `json:"epoch"`
	Exp   int64  `json:"exp"`
	Jti   string `json:"jti"`
}

// GenerateCallbackToken creates a signed callback token for a consumer.
func GenerateCallbackToken(consumerID string, epoch int) string {
	jti := make([]byte, 8)
	rand.Read(jti)

	payload := tokenPayload{
		Sub:   consumerID,
		Epoch: epoch,
		Exp:   time.Now().Unix() + 3600, // 1 hour TTL
		Jti:   hex.EncodeToString(jti),
	}

	payloadJSON, _ := json.Marshal(payload)
	payloadStr := base64.RawURLEncoding.EncodeToString(payloadJSON)

	mac := hmac.New(sha256.New, tokenKey)
	mac.Write([]byte(payloadStr))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return payloadStr + "." + sig
}

// TokenValidation is the result of validating a callback token.
type TokenValidation struct {
	Valid bool
	Exp   int64
	Code  string // "TOKEN_INVALID" or "TOKEN_EXPIRED" when !Valid
}

// ValidateCallbackToken verifies a callback token and returns the validation result.
func ValidateCallbackToken(token, consumerID string) TokenValidation {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return TokenValidation{Valid: false, Code: ErrCodeTokenInvalid}
	}

	payloadStr, sig := parts[0], parts[1]

	// Verify HMAC
	mac := hmac.New(sha256.New, tokenKey)
	mac.Write([]byte(payloadStr))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return TokenValidation{Valid: false, Code: ErrCodeTokenInvalid}
	}

	// Decode payload
	payloadJSON, err := base64.RawURLEncoding.DecodeString(payloadStr)
	if err != nil {
		return TokenValidation{Valid: false, Code: ErrCodeTokenInvalid}
	}

	var payload tokenPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return TokenValidation{Valid: false, Code: ErrCodeTokenInvalid}
	}

	if payload.Sub != consumerID {
		return TokenValidation{Valid: false, Code: ErrCodeTokenInvalid}
	}

	now := time.Now().Unix()
	if now > payload.Exp {
		return TokenValidation{Valid: false, Code: ErrCodeTokenExpired}
	}

	return TokenValidation{Valid: true, Exp: payload.Exp}
}

// TokenNeedsRefresh returns true if the token is within 5 minutes of expiry.
func TokenNeedsRefresh(exp int64) bool {
	now := time.Now().Unix()
	return exp-now <= tokenRefreshThreshold
}
