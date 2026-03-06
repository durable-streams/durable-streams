# StreamResponse Consumption Methods

A `StreamResponse<TJson>` provides three families of consumption methods.
Choose one per response — calling a second method throws `ALREADY_CONSUMED`.

## Promise-Based (await for complete result)

Use for catch-up reads (`live: false`) or when you want all data at once.

### `.json(): Promise<TJson[]>`

Returns all items as a parsed JSON array. JSON-mode streams only.

```typescript
const res = await stream<{ id: string }>({ url, offset: "-1", live: false })
const items = await res.json()
// items: Array<{ id: string }>
```

### `.text(): Promise<string>`

Returns the complete body as a string. Works with any content type.

```typescript
const res = await stream({ url, offset: "-1", live: false })
const text = await res.text()
```

### `.body(): Promise<Uint8Array>`

Returns the complete body as raw bytes.

```typescript
const res = await stream({ url, offset: "-1", live: false })
const bytes = await res.body()
```

## ReadableStream-Based (async iteration)

Use for processing items one at a time as they arrive.

### `.jsonStream(): ReadableStream<TJson>`

Yields individual JSON items. JSON-mode streams only.

```typescript
const res = await stream<{ event: string }>({ url, offset: "-1", live: true })
for await (const item of res.jsonStream()) {
  console.log(item.event)
}
```

### `.textStream(): ReadableStream<string>`

Yields text chunks as they arrive.

```typescript
const res = await stream({ url, offset: "-1", live: true })
for await (const chunk of res.textStream()) {
  process.stdout.write(chunk)
}
```

### `.bodyStream(): ReadableStream<Uint8Array>`

Yields raw byte chunks.

```typescript
const res = await stream({ url, offset: "-1", live: true })
for await (const chunk of res.bodyStream()) {
  processBytes(chunk)
}
```

## Subscriber-Based (callback with offset tracking)

Use for live subscriptions where you need the offset for checkpointing.

### `.subscribeJson(callback): () => void`

Calls back with batches of JSON items and offset.

```typescript
const res = await stream<{ event: string }>({ url, offset: "-1", live: true })
res.subscribeJson(async (batch) => {
  for (const item of batch.items) {
    console.log(item.event)
  }
  saveCheckpoint(batch.offset)
})
```

### `.subscribeText(callback): () => void`

Calls back with text data and offset.

```typescript
const res = await stream({ url, offset: "-1", live: true })
res.subscribeText(async (chunk) => {
  appendToUI(chunk.text)
  saveCheckpoint(chunk.offset)
})
```

### `.subscribeBytes(callback): () => void`

Calls back with byte data and offset.

```typescript
const res = await stream({ url, offset: "-1", live: true })
res.subscribeBytes(async (chunk) => {
  processBytes(chunk.data)
  saveCheckpoint(chunk.offset)
})
```

## Properties

| Property       | Type                  | Description                               |
| -------------- | --------------------- | ----------------------------------------- |
| `offset`       | `string`              | Current offset (updates after each chunk) |
| `contentType`  | `string \| undefined` | Content type from stream creation         |
| `live`         | `LiveMode`            | The live mode for this session            |
| `startOffset`  | `string`              | The offset this session started from      |
| `upToDate`     | `boolean`             | Whether caught up with all existing data  |
| `streamClosed` | `boolean`             | Whether the stream is permanently closed  |
| `closed`       | `Promise<void>`       | Resolves when the stream session ends     |

## Methods

| Method     | Description               |
| ---------- | ------------------------- |
| `cancel()` | Cancel the stream session |
