# DRAFT: Durable Streams Protocol Extension: Write Fencing

**Document:** Durable Streams Protocol Extension: Write Fencing  
**Version:** 1.0  
**Date:** 2026-08-31  
**Author:** Aditya Kumarakrishnan  
**Extends:** [The Durable Streams Protocol](../PROTOCOL.md), per Section 11.1

---

## Abstract

This document specifies **Write Fencing**, an extension to the Durable Streams Protocol. It binds the append data plane to the subscription generation fence of Section 7.3: a stream that opts in accepts writes from a woken worker only under a **write token** minted for the current claim, and a deposed, lapsed, or completed claim can never land another byte.

The base protocol's idempotent producers (Section 5.2.1) fence competing writers with client-declared epochs: any authorized writer may declare a higher `Producer-Epoch` and depose the current one. For single-writer streams driven by subscription wakes (Section 7), that is the wrong trust model — a deposed or paused worker (a "zombie") can re-declare a higher epoch and keep writing after its successor has taken over. This extension closes that hole by deriving the writer epoch from the claim generation the control plane granted, instead of trusting the writer's declaration.

## Table of Contents

1. [Scope and Conformance Language](#1-scope-and-conformance-language)
2. [Terminology](#2-terminology)
3. [Creating a Fenced Stream](#3-creating-a-fenced-stream)
4. [The Write Token](#4-the-write-token)
5. [Write Classes](#5-write-classes)
6. [Bound Producers](#6-bound-producers)
7. [The Seal](#7-the-seal)
8. [Rejection Disclosure](#8-rejection-disclosure)
9. [Subscription Delivery Additions](#9-subscription-delivery-additions)
10. [Security Considerations](#10-security-considerations)
11. [IANA Considerations](#11-iana-considerations)
12. [Implementations](#12-implementations)
13. [References](#13-references)

---

## 1. Scope and Conformance Language

This extension is a **pure superset** of the base protocol in the sense of Section 11.1: every rule below is conditional on a stream that was created with the `Write-Fence: true` header, and base protocol operations remain functional without extension support. On a stream that never opts in, a conforming server behaves byte-for-byte as the base protocol requires, and a base client never observes this extension.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

Unqualified references of the form "Section N.N" refer to the base protocol ([PROTOCOL.md](../PROTOCOL.md)); references to sections of this extension are qualified as "Section N of this document".

Rule identifiers `[WF-nn]` mark the testable obligations of this extension; a certified implementation (Section 12 of this document) maps each identifier to a conformance test.

## 2. Terminology

**Fenced stream**: A stream created with `Write-Fence: true`. The fencing rules of this document apply only to fenced streams.

**Write token**: An opaque credential minted by the server for one subscription claim (Section 7.2), scoped to the claim's linked streams, that authorizes the **fenced** write class for exactly the claim's `(generation, wake_id, holder)`.

**Claim generation**: The Section 7.3 subscription-level fencing counter. Under this extension it is also the **writer epoch** of the fenced class.

**Authority**: One incarnation of one subscription. The fence, its seal, and the non-interleaving guarantee are per authority; deleting and recreating a subscription creates a new authority.

**Fenced write**: A `POST` classed as riding the write token (Section 5 of this document). Subject to the marker, seal, and epoch checks.

**Open write**: Every other `POST` — the base Section 5.2/5.2.1 write of an authenticated principal. Unchanged by this extension except for the bound producer rule (Section 6 of this document) on fenced streams.

**Bound producer**: A `Producer-Id` for which a fenced write has been accepted on a given fenced stream. From then on that id belongs to the fenced class on that stream.

**Seal**: The durable per-authority record that a claim generation is closed on a stream. Written when the holder completes (`done`), releases, or is superseded, and when the subscription or stream is torn down.

## 3. Creating a Fenced Stream

A stream opts in at creation:

```
PUT {stream-url}
Content-Type: application/json
Write-Fence: true
```

- The server **MUST** treat `Write-Fence: true` on `PUT` as part of the stream's configuration for the idempotent-create comparison of Section 5.1: a re-`PUT` of an existing stream **MUST** agree on the fence (else `409 Conflict`, stream exists with different configuration), and a re-`PUT` that agrees is a `200 OK` as today. **[WF-01]**
- The server **MUST** echo `Write-Fence: true` on the `PUT` response (`201` and idempotent `200`) and on `HEAD` for a fenced stream. **[WF-02]**
- A fork of a fenced stream **MUST NOT** inherit the fence: the fork is fenced iff its own `PUT` says so. **[WF-03]**
- A server that implements this extension but cannot honor a fenced create — for instance, its storage backend cannot provide the atomic fence of [WF-12] — **MUST** refuse the `PUT` rather than create a stream whose fence it would under-enforce; `501 Not Implemented` is **RECOMMENDED**. **[WF-04]**
- A server that does not implement this extension ignores `Write-Fence` as an unknown extension header, per the Section 11.1 rules, and creates the stream unfenced. A client that requires fencing therefore **MUST** check for the `Write-Fence: true` echo on the `PUT` response ([WF-02]) before treating the stream as fenced; a response without the echo means the stream is not fenced.
- Any `Write-Fence` value other than `true` is ignored, as for `Stream-Closed`.

## 4. The Write Token

The write token is the fenced class's credential. Its lifecycle follows the claim lifecycle of Sections 7.1–7.3:

- It is minted by a successful Section 7.2 claim (`write_token` in the claim response), refreshed by every non-`done` ack or webhook callback (`write_token` in the ack response), and delivered to webhook consumers in the Section 7.1 wake notification (`write_token` field) — see Section 9 of this document.
- It is carried on a `POST` in the `Write-Token` header.
- It is bound to one claim — the subscription, its incarnation, the generation, the `wake_id`, and the holder — and scoped to the exact stream paths of the claim's links. A valid token appends to a linked fenced stream **[WF-05]**; a token presented against a stream outside its scope **MUST** be rejected `403` **[WF-06]**; an expired or otherwise invalid token **MUST** be rejected `401`. **[WF-07]**
- A presented-but-malformed carrier (a duplicated `Write-Token` header, or one with an empty value) **MUST** be treated as a presented, invalid credential (`401`) — it **MUST NOT** fall through to another carrier or downgrade the request to the open class.
- The server **MUST** install the stream-side fence state for a claim before it releases that claim's write token to any consumer, so no token exists whose fence could not yet refuse its successor. **[WF-08]**

The dedicated `Write-Token` header is the only carrier this document defines. A server **MAY** additionally accept the token as an `Authorization: Bearer` credential, but only where that header is not already claimed by the deployment's Section 12.1 authentication — the write token **MUST NOT** displace or double as deployment authentication. When both carriers are present, `Write-Token` is the write token and `Authorization` is evaluated under Section 12.1 alone.

The write token proves _capability_ (the current claim), not liveness alone. A credential that only identifies a wake or callback context **MUST NOT** be accepted in its place (Section 5 of this document).

## 5. Write Classes

On a fenced stream, the server derives one of two classes for every `POST` — append, append-and-close, or close-only — before any mutation. The class is **fenced** iff the request presents a write-token carrier or asserts the class with `Write-Fence: true`; it is **open** otherwise. The class is derived server-side from what the request carries; there is no client-negotiated mode.

Rules for the fenced class:

- A `POST` asserting `Write-Fence: true` without a write token **MUST** be rejected `401` — on every stream, fenced or not, so a gateway can make the assertion unconditionally on routes that must never write unfenced. **[WF-09]**
- A fenced write **MUST** carry all three producer headers (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`); the server **MUST** reject `400` otherwise. **[WF-10]**
- `Producer-Epoch` **MUST** equal the token's claim generation; the server **MUST** reject `409` (reason `epoch`) otherwise. The claim generation is the fenced class's writer epoch, so a writer cannot self-declare an epoch the control plane did not grant it. **[WF-11]**
- The server **MUST** evaluate the fence **atomically with the write**, against current fence state: a token whose claim is no longer the stream's live, unexpired claim marker **MUST** be rejected `409` (reason `marker`, or `precheck` when a pre-check answers before the atomic commit) with the stream tail unchanged. **[WF-12]** A claim whose lease has lapsed **MUST** be fenced the same way, judged against the same clock as the append itself. **[WF-13]**
- Only after the fence accepts does the base Section 5.2.1 producer validation run, unchanged.

Rules for the open class on a fenced stream:

- An open write **MUST** be attributable to an authenticated principal; the authentication mechanism is implementation-defined per Section 12.1. An unauthenticated open write on a fenced stream **MUST** be rejected `401` when the server enforces authentication; the rejection is the base authentication failure and carries no fence disclosure (see Section 8 of this document, [WF-26]). **[WF-14]**
- A credential that proves only wake or callback identity (liveness, not the claim capability) **MUST NOT** write a fenced stream: reject `403`. **[WF-15]**
- Otherwise the open class is the base protocol, byte-for-byte: Section 5.2 body and header semantics, the Section 5.2.1 producer state machine, closure, and content-type rules are unchanged (subject only to Section 6 of this document).

## 6. Bound Producers

The fenced class carries stable producer ids, so a writer that loses its token must not be able to keep the same identity and epoch sequence going as an "open" writer — that would be the zombie this extension exists to stop.

- After a fenced write is accepted for a `Producer-Id` on a fenced stream, an open write naming that id **MUST** be rejected `409` (reason `bound`). **[WF-16]**
- This includes a byte-identical retry of an accepted fenced tuple arriving without the token: idempotent replay of the fenced class is fenced-class only. **[WF-17]**
- For producer ids never bound, the Section 5.2.1 state machine on the open class is unchanged: an unbound producer establishes its epoch on a fenced stream exactly as on any stream. **[WF-18]**

The binding is per stream and lives as long as the stream. Writers **SHOULD** partition producer-id namespaces between the two classes (see Section 10 of this document).

## 7. The Seal

Completion must be as final as deposition. When a holder finishes (`done`), releases, or is superseded — and when the subscription or the stream link is torn down — the generation is **sealed** on every linked fenced stream:

- The server **MUST** seal the current generation on every linked fenced stream **before** the control plane completes the `done`/release and the subscription becomes claimable again. After the seal, any write presenting that generation (or an earlier one) of that authority **MUST** be rejected `409` (reason `sealed`, or `precheck` when a pre-check answers before the atomic commit). **[WF-19]**
- `HEAD` on a fenced stream with at least one seal **MUST** expose the latest seal as `Write-Fence-Sealed-Generation` and `Write-Fence-Sealed-Offset` — the definite last offset the sealed generation's fenced class reached. **[WF-20]**
- When a successor's claim supersedes a live predecessor, the grant **MUST** record the superseded generation's seal (its final fenced offset) as part of installing the new generation's fence. **[WF-21]**
- Sealing **MUST** be idempotent: a redelivered `done` (at-least-once delivery) re-seals the same generation with no state change. **[WF-22]**
- The seal is **per authority**: it fences every generation of its authority at or below the sealed generation, forever — a grant for such a generation **MUST** be refused no matter how delayed — but a new incarnation of the subscription is a new authority and starts unsealed. Recreating a subscription **MUST NOT** be bricked by its predecessor's seals. **[WF-23]**

The seal gives readers a truncation guarantee: after `done` at generation _g_, the offset in the seal is the last byte the fenced class had written when the seal was recorded — when the class never wrote, it falls back to the stream tail at the seal — and nothing of generation ≤ _g_ of that authority can ever append after it.

## 8. Rejection Disclosure

A fence rejection tells the writer enough to stand down without a read:

- Data-plane fence rejections use `409 Conflict` with the JSON error envelope of Section 7.2, code `FENCED`, extended with a `reason` field naming the rule that refused the write, plus `generation` (the current generation, when the fence state knows one) and `current_holder` (when a live, unexpired claim holds the stream):

  ```json
  {
    "error": {
      "code": "FENCED",
      "message": "write token claim is fenced",
      "reason": "marker",
      "generation": 9,
      "current_holder": "worker-B"
    }
  }
  ```

  `reason` is drawn from exactly the vocabulary this extension defines — a `409 FENCED` **MUST NOT** carry any other value: **[WF-24]**
  - `epoch`: the fenced write's `Producer-Epoch` does not equal the token's claim generation ([WF-11]).
  - `marker`: the token's claim is no longer the stream's live, unexpired claim marker — including a claim whose lease has lapsed ([WF-12], [WF-13]).
  - `precheck`: the rejection came from a pre-check answering before the atomic commit, in place of `marker` or `sealed` ([WF-12], [WF-19]).
  - `sealed`: the write presents a sealed generation of the stream's authority, or an earlier one ([WF-19]).
  - `bound`: an open write names a producer id bound to the fenced class ([WF-16]).

  The `400`/`401`/`403` rejections of Sections 4–5 of this document are not fence `409`s and carry no `reason`; the WF-14 `401` in particular is the base authentication failure.

- When the rejected request carried producer headers, a `409 FENCED` **MUST** also carry `Producer-Epoch: <current generation>` (when known) and the **terminal gap pair** `Producer-Expected-Seq` == `Producer-Received-Seq` == the request's `Producer-Seq`. The pair is impossible in the base protocol (a real sequence gap always has expected < received), so a base Section 5.2.1 client library observing it stops cleanly on the first response instead of retrying or re-reading. **[WF-25]**
- The pre-credential rejections (`401`/`403` of Section 5 of this document) **MUST NOT** disclose fence state: no generation, no holder, no producer echo — an unauthenticated caller learns nothing about the stream. **[WF-26]**
- A `409 FENCED` **MUST NOT** carry `Stream-Next-Offset`: a deposed writer stands down; it does not resume.

Precedence on a fenced stream: within the atomic commit the fence is evaluated before the base closed, Section 5.2.1 producer, and `Stream-Seq` checks, so a deposed writer learns it is fenced rather than a coincidental base error. The base Section 5.2 content-type check is not so ordered: a server **MAY** answer the plain `409` content-type mismatch before evaluating the fence.

## 9. Subscription Delivery Additions

The write token rides the Section 7 delivery surfaces as three additive, optional JSON fields — omitted when absent, and ignored by base clients:

- Section 7.2 claim response: `write_token` (alongside the claim `token`).
- Section 7.2 ack response (non-`done`): `write_token`, re-minted on every heartbeat so a long-running holder outlives the token TTL; the heartbeat also renews the fence state it rides on.
- Section 7.1 webhook wake notification: `write_token`, minted before delivery.

Webhook and pull-wake delivery are symmetric under this extension. A webhook consumer **MUST** be able to write fenced streams, heartbeat to refresh its token, and complete with `done` — including the seal — with the holder identity derived from the wake when no worker claims it. **[WF-27]** A pull-wake worker **MUST** be able to do all of the same through its Section 7.2 claim, ack, and release cycle. **[WF-28]**

A failure to mint the token for a webhook delivery **SHOULD NOT** abort the delivery (fail-open delivery, fail-closed token): the notification goes out without `write_token`, and the consumer's fenced writes fail closed.

## 10. Security Considerations

**Token custody.** The write token is a bearer capability for the fenced class. Consumers **MUST NOT** log it or persist it beyond the claim; transport **MUST** be protected as Section 12.11 requires.

**Stateless gateways.** A gateway forwarding writes for a woken runtime **SHOULD** pass the runtime's token through in `Write-Token` while authenticating itself in `Authorization`, keeping the two credentials separate; the server evaluates both (the gateway's principal for routing, the token for the fenced class).

**The trusted-gateway residual.** A writer behind a trusted gateway that drops _both_ its token and its producer headers is an open write under the gateway's authority — the fence cannot distinguish it from any other gateway write. A gateway **MUST** assert `Write-Fence: true` on routes that carry fenced-class output (worker output, not command traffic), turning a lost token into a loud `401` instead of a silent downgrade (Section 5 of this document, [WF-09]).

**At-least-once completion.** `done` and the seal are at-least-once; the idempotence rules of Section 7 apply. A crash between the seal and the control-plane completion leaves the subscription live but its streams sealed: the holder's retry completes the seal, and its heartbeat cannot revive the sealed generation.

**Linking discipline.** The non-interleaving guarantee is per authority. Deployments **MUST** link at most one subscription to a fenced stream; two authorities on one stream each get correct fencing, but their writes may interleave with each other. Similarly, deployments **SHOULD** reserve a producer-id namespace for the fenced class (e.g. a prefix used only by woken workers) so the bound-producer rule (Section 6 of this document) partitions cleanly.

## 11. IANA Considerations

This document requests registration of the following HTTP headers in the "Permanent Message Header Field Names" registry, extending the table of Section 13.2:

| Field Name                      | Status    | Reference     |
| ------------------------------- | --------- | ------------- |
| `Write-Fence`                   | permanent | This document |
| `Write-Token`                   | permanent | This document |
| `Write-Fence-Sealed-Generation` | permanent | This document |
| `Write-Fence-Sealed-Offset`     | permanent | This document |

**Descriptions:**

- `Write-Fence`: On `PUT`, opts the stream into write fencing; on `POST`, asserts the fenced write class; echoed on `PUT` and `HEAD` responses (value `true`)
- `Write-Token`: Claim-scoped credential authorizing the fenced write class, used on `POST` requests (opaque string)
- `Write-Fence-Sealed-Generation`: Latest sealed claim generation of a fenced stream, on `HEAD` responses (integer)
- `Write-Fence-Sealed-Offset`: Final fenced-class offset of the latest sealed generation, on `HEAD` responses (opaque string)

## 12. Implementations

[Chronicle](https://github.com/adityavkk/chronicle) is a certified implementation of this extension: a Go, Redis-backed Durable Streams server, passing 332/332 against `@durable-streams/server-conformance-tests@0.3.5` with the base protocol pinned at commit `82f9963` (see its [SPEC_VERSION.md](https://github.com/adityavkk/chronicle/blob/main/SPEC_VERSION.md)).

- **Extension conformance suite** ([`test/conformance-ext`](https://github.com/adityavkk/chronicle/tree/main/test/conformance-ext)): 33 black-box tests — one per `[WF-nn]` rule, four negative controls pinning that base-protocol behavior on unfenced streams is untouched, and a control that drives the pinned `@durable-streams/client` `IdempotentProducer` against a fenced stream after a takeover and asserts the terminal gap pair (Section 8 of this document) stops it cleanly within one batch. Fault-injection builds remove the producer binding, the seal, and the terminal pair in turn and verify the corresponding tests fail.
- **Formal model** ([`formal/tla/WriteFence.tla`](https://github.com/adityavkk/chronicle/blob/main/formal/tla/WriteFence.tla)): a TLC-checked model of the fence whose invariants include epoch non-interleaving and seal finality; fault configurations reproduce the zombie interleavings this extension prevents.
- **Design record**: [ADR-0008](https://github.com/adityavkk/chronicle/blob/main/docs/adr/0008-write-fencing-extension.md), plus Chronicle's annotated copy of this extension ([docs/spec/WRITE-FENCING.md](https://github.com/adityavkk/chronicle/blob/main/docs/spec/WRITE-FENCING.md)) recording implementation notes: carrier aliases, storage layout, access-control-mode interaction, and known limitations.

## 13. References

[PROTOCOL] "The Durable Streams Protocol", [PROTOCOL.md](../PROTOCOL.md), this repository.

[RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>.

[RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017, <https://www.rfc-editor.org/info/rfc8174>.
