/**
 * JSON-mode helpers.
 *
 * Ported from the Durable Streams reference server
 * (packages/server/src/store.ts, Apache-2.0, Durable Stream contributors).
 *
 * JSON streams store each POST as one comma-terminated fragment
 * (`{"a":1},{"b":2},`); reads concatenate fragments, strip the trailing
 * comma, and wrap the result in `[...]` so a multi-message GET body is a
 * single valid JSON array.
 */

export class JsonAppendError extends Error {}

/** Normalize content-type by extracting the media type (before any semicolon). */
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return "";
  const mediaType = contentType.split(";")[0];
  return mediaType === undefined ? "" : mediaType.trim().toLowerCase();
}

/**
 * Process JSON data for append: validate, flatten a top-level array one
 * level, and append a trailing comma for concatenation.
 *
 * @param isInitialCreate - empty arrays are allowed on PUT (creates an
 * empty stream) but rejected on POST.
 * @throws JsonAppendError on invalid JSON or an empty array append.
 */
export function processJsonAppend(
  data: Uint8Array,
  isInitialCreate = false,
): Uint8Array {
  const text = new TextDecoder().decode(data);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JsonAppendError("Invalid JSON");
  }

  let result: string;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      if (isInitialCreate) {
        return new Uint8Array(0);
      }
      throw new JsonAppendError("Empty arrays are not allowed");
    }
    const elements = parsed.map((item) => JSON.stringify(item));
    result = elements.join(",") + ",";
  } else {
    // Single value - re-serialize to normalize whitespace
    result = JSON.stringify(parsed) + ",";
  }

  return new TextEncoder().encode(result);
}

function decodeStoredJsonFragment(data: Uint8Array): string {
  let text = new TextDecoder().decode(data).trimEnd();
  if (text.endsWith(",")) {
    text = text.slice(0, -1);
  }
  return text;
}

/**
 * Format stored JSON fragments as a single JSON array body.
 */
export function formatJsonMessages(fragments: Uint8Array[]): Uint8Array {
  if (fragments.length === 0) {
    return new TextEncoder().encode("[]");
  }

  const items = fragments.map((data) => decodeStoredJsonFragment(data));
  return new TextEncoder().encode(`[${items.join(",")}]`);
}

/** Concatenate raw message bodies (non-JSON streams). */
export function concatBytes(fragments: Uint8Array[]): Uint8Array {
  const totalSize = fragments.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const f of fragments) {
    out.set(f, pos);
    pos += f.length;
  }
  return out;
}
