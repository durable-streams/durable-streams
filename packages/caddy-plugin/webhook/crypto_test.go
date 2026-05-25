package webhook

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
)

func TestSignWebhookPayloadUsesJWKSKey(t *testing.T) {
	body := `{"ok":true}`
	header := SignWebhookPayload(body)

	parts := map[string]string{}
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			t.Fatalf("malformed signature part %q", part)
		}
		parts[key] = value
	}

	if parts["kid"] != GetWebhookSigningKeyID() {
		t.Fatalf("signature kid %q did not match active key %q", parts["kid"], GetWebhookSigningKeyID())
	}

	jwks := GetWebhookJWKS()
	if len(jwks.Keys) != 1 {
		t.Fatalf("expected one webhook signing key, got %d", len(jwks.Keys))
	}
	if jwks.Keys[0].Kid != parts["kid"] {
		t.Fatalf("JWKS kid %q did not match signature kid %q", jwks.Keys[0].Kid, parts["kid"])
	}

	publicKey, err := base64.RawURLEncoding.DecodeString(jwks.Keys[0].X)
	if err != nil {
		t.Fatalf("failed to decode public key: %v", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts["ed25519"])
	if err != nil {
		t.Fatalf("failed to decode signature: %v", err)
	}

	payload := parts["t"] + "." + body
	if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(payload), signature) {
		t.Fatal("webhook signature did not verify")
	}
}
