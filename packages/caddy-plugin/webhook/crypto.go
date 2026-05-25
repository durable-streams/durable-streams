package webhook

import (
	"crypto/ed25519"
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
var webhookPublicKey ed25519.PublicKey
var webhookPrivateKey ed25519.PrivateKey
var webhookPublicJWK WebhookPublicJWK

func init() {
	tokenKey = make([]byte, 32)
	if _, err := rand.Read(tokenKey); err != nil {
		panic(fmt.Sprintf("failed to generate token key: %v", err))
	}

	var err error
	webhookPublicKey, webhookPrivateKey, err = ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(fmt.Sprintf("failed to generate webhook signing key: %v", err))
	}
	webhookPublicJWK = buildWebhookPublicJWK(webhookPublicKey)
}

const tokenRefreshThreshold = 300 // 5 minutes in seconds

// WebhookPublicJWK is the public Ed25519 webhook signing key in JWK form.
type WebhookPublicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	X   string `json:"x"`
}

// WebhookJWKS is the JSON Web Key Set served to webhook receivers.
type WebhookJWKS struct {
	Keys []WebhookPublicJWK `json:"keys"`
}

func buildWebhookPublicJWK(publicKey ed25519.PublicKey) WebhookPublicJWK {
	x := base64.RawURLEncoding.EncodeToString(publicKey)
	thumbprintInput := fmt.Sprintf(`{"crv":"Ed25519","kty":"OKP","x":"%s"}`, x)
	thumbprint := sha256.Sum256([]byte(thumbprintInput))

	return WebhookPublicJWK{
		Kty: "OKP",
		Crv: "Ed25519",
		Kid: "ds_" + base64.RawURLEncoding.EncodeToString(thumbprint[:]),
		Use: "sig",
		Alg: "EdDSA",
		X:   x,
	}
}

// GetWebhookSigningKeyID returns the active webhook signing key ID.
func GetWebhookSigningKeyID() string {
	return webhookPublicJWK.Kid
}

// GetWebhookJWKS returns the active webhook signing public key set.
func GetWebhookJWKS() WebhookJWKS {
	return WebhookJWKS{
		Keys: []WebhookPublicJWK{webhookPublicJWK},
	}
}

// GenerateWakeID creates a unique wake ID prefixed with "w_".
func GenerateWakeID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "w_" + hex.EncodeToString(b)
}

// SignWebhookPayload signs a webhook body with the server webhook signing key.
// Returns "t=<unix_ts>,kid=<key_id>,ed25519=<base64url_sig>".
func SignWebhookPayload(body string) string {
	timestamp := time.Now().Unix()
	payload := fmt.Sprintf("%d.%s", timestamp, body)
	sig := ed25519.Sign(webhookPrivateKey, []byte(payload))
	return fmt.Sprintf(
		"t=%d,kid=%s,ed25519=%s",
		timestamp,
		webhookPublicJWK.Kid,
		base64.RawURLEncoding.EncodeToString(sig),
	)
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
