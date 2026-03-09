package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const DefaultJSONSchemaDialect = "https://json-schema.org/draft/2020-12/schema"

var supportedJSONSchemaDialects = map[string]struct{}{
	DefaultJSONSchemaDialect:       {},
	DefaultJSONSchemaDialect + "#": {},
}

// NormalizedSchema contains the effective schema document and its digest.
type NormalizedSchema struct {
	SchemaDocument json.RawMessage
	SchemaDigest   string
}

// ParseAndNormalizeSchemaDocument parses JSON bytes, validates JSON Schema semantics,
// materializes default dialect, and computes a canonical digest.
func ParseAndNormalizeSchemaDocument(body []byte) (*NormalizedSchema, error) {
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, ErrInvalidSchema
	}
	return NormalizeAndValidateSchemaDocument(parsed)
}

// NormalizeAndValidateSchemaDocument validates a schema document and returns
// the pinned effective schema (including default $schema when omitted).
func NormalizeAndValidateSchemaDocument(schemaDocument any) (*NormalizedSchema, error) {
	root, ok := schemaDocument.(map[string]any)
	if !ok {
		return nil, ErrInvalidSchema
	}

	declaredDialect, hasDialect := root["$schema"]
	if hasDialect {
		dialectStr, ok := declaredDialect.(string)
		if !ok {
			return nil, ErrInvalidSchema
		}
		if _, ok := supportedJSONSchemaDialects[dialectStr]; !ok {
			return nil, ErrInvalidSchema
		}
	}

	effective := make(map[string]any, len(root)+1)
	for k, v := range root {
		effective[k] = v
	}
	if !hasDialect {
		effective["$schema"] = DefaultJSONSchemaDialect
	}

	normalizedBytes, err := json.Marshal(effective)
	if err != nil {
		return nil, ErrInvalidSchema
	}

	if err := validateSchemaDocument(normalizedBytes); err != nil {
		return nil, ErrInvalidSchema
	}

	digest := sha256.Sum256(normalizedBytes)
	return &NormalizedSchema{
		SchemaDocument: normalizedBytes,
		SchemaDigest:   "sha-256:" + hex.EncodeToString(digest[:]),
	}, nil
}

func NewSchemaMessageValidator(schemaDocument json.RawMessage) (*jsonschema.Schema, error) {
	var parsed any
	if err := json.Unmarshal(schemaDocument, &parsed); err != nil {
		return nil, err
	}

	// This protocol version requires schemas to be self-contained.
	if hasExternalRefs(parsed) {
		return nil, ErrInvalidSchema
	}

	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource("inmemory:///stream-schema.json", parsed); err != nil {
		return nil, err
	}
	return compiler.Compile("inmemory:///stream-schema.json")
}

func validateSchemaDocument(schemaDocument json.RawMessage) error {
	_, err := NewSchemaMessageValidator(schemaDocument)
	return err
}

func hasExternalRefs(value any) bool {
	switch node := value.(type) {
	case map[string]any:
		for key, v := range node {
			if key == "$ref" {
				ref, ok := v.(string)
				if ok && ref != "" && !strings.HasPrefix(ref, "#") {
					return true
				}
			}
			if hasExternalRefs(v) {
				return true
			}
		}
	case []any:
		for _, item := range node {
			if hasExternalRefs(item) {
				return true
			}
		}
	}
	return false
}
