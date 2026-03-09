import { createHash } from "node:crypto"
import Ajv2020 from "ajv/dist/2020.js"
import { canonicalize } from "json-canonicalize"
import type { ValidateFunction } from "ajv"

export const DEFAULT_JSON_SCHEMA_DIALECT = `https://json-schema.org/draft/2020-12/schema`

const SUPPORTED_JSON_SCHEMA_DIALECTS = new Set([
  DEFAULT_JSON_SCHEMA_DIALECT,
  `${DEFAULT_JSON_SCHEMA_DIALECT}#`,
])

export class SchemaDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `SchemaDocumentError`
  }
}

export class SchemaValidationFailureError extends Error {
  constructor() {
    super(`JSON schema validation failed`)
    this.name = `SchemaValidationFailureError`
  }
}

export interface NormalizedSchema {
  schemaDocument: Record<string, unknown>
  schemaDigest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === `object` && value !== null && !Array.isArray(value)
}

function createAjv(): Ajv2020 {
  return new Ajv2020({
    strict: false,
    allErrors: true,
    validateSchema: true,
    addUsedSchema: false,
  })
}

function toSchemaDigest(schemaDocument: Record<string, unknown>): string {
  const canonical = canonicalize(schemaDocument)
  const digest = createHash(`sha256`)
    .update(Buffer.from(canonical, `utf8`))
    .digest(`hex`)
  return `sha-256:${digest}`
}

export function normalizeAndValidateSchemaDocument(
  schemaDocument: unknown
): NormalizedSchema {
  if (!isRecord(schemaDocument)) {
    throw new SchemaDocumentError(`Invalid JSON schema document`)
  }

  const declaredDialect = schemaDocument[`$schema`]
  if (
    declaredDialect !== undefined &&
    (typeof declaredDialect !== `string` ||
      !SUPPORTED_JSON_SCHEMA_DIALECTS.has(declaredDialect))
  ) {
    throw new SchemaDocumentError(`Unsupported JSON schema dialect`)
  }

  const effectiveSchema = {
    ...schemaDocument,
    $schema:
      typeof declaredDialect === `string`
        ? declaredDialect
        : DEFAULT_JSON_SCHEMA_DIALECT,
  }

  const ajv = createAjv()
  if (!ajv.validateSchema(effectiveSchema)) {
    throw new SchemaDocumentError(`Invalid JSON schema document`)
  }

  // Compiling is also required so schemas that need external $ref resolution
  // are rejected in this protocol version.
  try {
    ajv.compile(effectiveSchema)
  } catch {
    throw new SchemaDocumentError(`Invalid JSON schema document`)
  }

  return {
    schemaDocument: effectiveSchema,
    schemaDigest: toSchemaDigest(effectiveSchema),
  }
}

export function parseAndNormalizeSchemaDocument(
  body: Uint8Array
): NormalizedSchema {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new SchemaDocumentError(`Invalid JSON schema document`)
  }

  return normalizeAndValidateSchemaDocument(parsed)
}

export function createSchemaMessageValidator(
  schemaDocument: Record<string, unknown>
): ValidateFunction {
  const ajv = createAjv()
  return ajv.compile(schemaDocument)
}
