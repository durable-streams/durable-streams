/**
 * Smoke test using @durable-streams/client (deliverable 4):
 *  1. create a JSON stream
 *  2. append 1,000 events in batches
 *  3. catch-up read from a mid-stream offset
 *  4. SSE live tail while appending
 *  5. close; verify EOF surfaces in catch-up, long-poll, and SSE modes
 *
 * Usage: node scripts/smoke-test.mjs [baseUrl]   (default http://localhost:8787)
 */
import { DurableStream, IdempotentProducer } from "@durable-streams/client";

const BASE =
  process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:8787";
const url = `${BASE}/v1/stream/smoke-${Date.now()}`;

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}

console.log(`Smoke test against ${url}`);

// 1. Create a JSON stream
const handle = await DurableStream.create({
  url,
  contentType: "application/json",
});
console.log("created JSON stream");

// 2. Append 1,000 events in batches via IdempotentProducer (the client's
// batching writer: fire-and-forget appends are coalesced into batched
// POSTs with exactly-once (producerId, epoch, seq) semantics).
const TOTAL_EVENTS = 1000;
const producerErrors = [];
const producer = new IdempotentProducer(handle, "smoke-producer-1", {
  onError: (err) => producerErrors.push(err),
});
let midOffset;
for (let i = 0; i < TOTAL_EVENTS; i++) {
  producer.append(JSON.stringify({ seq: i, payload: `event-${i}` }));
  if (i === TOTAL_EVENTS / 2 - 1) {
    await producer.flush();
    midOffset = (await handle.head()).offset;
  }
}
await producer.flush();
check(
  producerErrors.length === 0,
  `producer reported no batch errors (got ${producerErrors.length})`,
);
console.log(
  `appended ${TOTAL_EVENTS} events in batches via IdempotentProducer`,
);

// 3. Catch-up read from the mid-stream offset
{
  const res = await handle.stream({ offset: midOffset, live: false });
  const items = await res.json();
  check(
    items.length === 500,
    `catch-up from mid offset returns 500 events (got ${items.length})`,
  );
  check(
    items[0]?.seq === 500,
    `first event after mid offset has seq 500 (got ${items[0]?.seq})`,
  );
  check(
    items[items.length - 1]?.seq === 999,
    `last event has seq 999 (got ${items[items.length - 1]?.seq})`,
  );
}

// Full catch-up read from the beginning
{
  const res = await handle.stream({ live: false });
  const items = await res.json();
  check(
    items.length === 1000,
    `full catch-up returns 1000 events (got ${items.length})`,
  );
}

// 4. SSE live tail while appending
const LIVE_EVENTS = 25;
const tailOffset = (await handle.head()).offset;
const tail = await handle.stream({ offset: tailOffset, live: "sse" });
const liveReceived = [];
let liveResolve;
const liveDone = new Promise((resolve) => {
  liveResolve = resolve;
});
tail.subscribeJson((batch) => {
  liveReceived.push(...batch.items);
  if (liveReceived.length >= LIVE_EVENTS) liveResolve();
});

for (let i = 0; i < LIVE_EVENTS; i++) {
  await handle.append(JSON.stringify({ seq: 1000 + i, live: true }));
}
await Promise.race([
  liveDone,
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("SSE live tail timed out after 15s")),
      15000,
    ),
  ),
]);
check(
  liveReceived.length === LIVE_EVENTS,
  `SSE live tail received ${LIVE_EVENTS} events while appending (got ${liveReceived.length})`,
);
check(
  liveReceived[0]?.seq === 1000,
  `first live event has seq 1000 (got ${liveReceived[0]?.seq})`,
);

// 5. Close, then verify EOF in all three read modes
await handle.close();
console.log("closed stream");

// 5a. EOF via the live SSE tail: server must end the connection with streamClosed
await Promise.race([
  tail.closed,
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("SSE did not observe close after 15s")),
      15000,
    ),
  ),
]);
check(tail.streamClosed === true, "SSE live tail observed streamClosed (EOF)");

// 5b. EOF via catch-up read
{
  const res = await handle.stream({ live: false });
  const items = await res.json();
  check(
    items.length === 1025,
    `catch-up after close returns all 1025 events (got ${items.length})`,
  );
  check(res.streamClosed === true, "catch-up read observed streamClosed (EOF)");
}

// 5c. EOF via long-poll at the final offset (raw fetch to assert protocol shape)
{
  const finalOffset = (await handle.head()).offset;
  const resp = await fetch(
    `${url}?offset=${encodeURIComponent(finalOffset)}&live=long-poll`,
  );
  check(
    resp.status === 204,
    `long-poll at final offset returns 204 (got ${resp.status})`,
  );
  check(
    resp.headers.get("stream-closed") === "true",
    "long-poll response carries Stream-Closed: true (EOF)",
  );
}

if (failures > 0) {
  console.error(`\nSmoke test FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nSmoke test PASSED: all checks green");
