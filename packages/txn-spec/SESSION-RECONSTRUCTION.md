# Session Reconstruction: From CobbleDB Paper to Living Guide

A detailed account of how a research paper on formalizing transactional storage systems was transformed into a 3,700-line living guide with executable specifications, three case studies, and 522 passing tests—across two Claude Code sessions.

---

## Background

**The paper**: "Formalising Transactional Storage Systems" (CobbleDB, ASPLOS '23) — a formal framework for specifying and testing transactional key-value stores using snapshot isolation, effect algebras, and history-based consistency checking.

**The codebase**: [durable-streams](https://github.com/anthropics/durable-streams) — a protocol and set of implementations for persistent, resumable event streams over HTTP. The `txn-spec` package was created to provide formal specification tooling for transactional storage built on top of durable streams.

**The tool**: Claude Code (CLI), running Claude Opus 4.6 with 1M context.

---

## Session 1: Building the Foundation

### Phase 1: The DSL and Implementation (~8 commits)

The first session began with the user sharing the CobbleDB paper and asking Claude to build a TypeScript DSL for formal specification of transactional storage systems. This produced the core `txn-spec` package:

**Source files created** (7,305 lines):

| File | Lines | Purpose |
|------|-------|---------|
| `src/types.ts` | 375 | Core type definitions (TxnId, Key, Value, Effect, etc.) |
| `src/effects.ts` | 496 | Effect algebra (assign, increment, delete, compose, merge) |
| `src/store.ts` | 1,088 | MapStore reference implementation |
| `src/stream-store.ts` | 592 | StreamStore optimized implementation |
| `src/transaction.ts` | 779 | Transaction coordinator with snapshot isolation |
| `src/scenario.ts` | 1,180 | Fluent scenario builder DSL |
| `src/trace.ts` | 666 | Execution tracing and event recording |
| `src/fuzz.ts` | 607 | Seeded random number generator and fuzz framework |
| `src/test-generator.ts` | 598 | Random scenario generation |
| `src/http-api.ts` | 501 | Batch transaction HTTP API |
| `src/test.ts` | 338 | Test runner and formatters |
| `src/index.ts` | 434 | Public API exports |

**Test files created** (6 files, ~1,727 lines initially):

| File | Tests | Purpose |
|------|-------|---------|
| `conformance.test.ts` | 82 | Core behavior conformance tests |
| `merge-properties.test.ts` | 203 | Algebraic property tests for CAI merge laws |
| `fuzz.test.ts` | 20 | Seeded fuzz testing for store consistency |
| `http-api.test.ts` | 13 | Batch transaction HTTP API tests |

### Phase 2: The Guide (~2 commits)

The user then asked Claude to write a comprehensive guide on building testing DSLs for complex systems, drawing from the CobbleDB paper, Jepsen/Elle, property-based testing, and the txn-spec implementation itself.

**GUIDE.md created** (~985 lines initially) covering:
- Parts 0-9: From formal foundations through practical patterns and LLM-guided testing
- Incorporated concepts from a "configurancy" blog post the user shared (bounded agents, shared intelligibility, external hardness oracles)

### Phase 3: Formal Specification and History Verification (~1 commit)

The user asked to formalize the specification:

**SPEC.md created** (315 lines):
- 8 affordances (A1-A8): Create, Read, Update, Delete, Begin, Commit, Abort, Snapshot Read
- 8 invariants (I1-I8): Snapshot Isolation, Atomicity, Effect Composition, OTSP Visibility, etc.
- 5 constraints (C1-C5): Single Active Transaction, Committed Transaction Finality, etc.
- 5 semantic decisions documenting design choices

**history.ts created** (578 lines):
- Elle-style dependency graph analysis
- WW (write-write), WR (write-read), RW (read-write anti-dependency) edge detection
- Cycle detection for serializability checking
- Snapshot isolation verification

**New test files**:
- `spec-vectors.test.ts` (9 tests): Test vectors TV1-TV7 derived from the paper
- `history.test.ts` (12 tests): WW/WR/RW edges, cycle detection

**End of Session 1**: ~415 tests passing.

---

## Session 2: The Review-Driven Evolution

Session 2 began with the context summary from Session 1 and proceeded through several distinct phases, each driven by external feedback.

### Phase 4: Formal Verification Expert Review

The user shared a detailed review from someone knowledgeable in formal verification. The review contained 12+ specific suggestions:

**Corrections**:
- Fixed wrong DOI for CobbleDB paper (was pointing to an ELISA paper)
- Fixed code nits: added `rng.chance()` method, `builder.abort()` method

**Major additions to GUIDE.md**:

1. **Part 10: Formal Verification Background** — A comprehensive history from Hoare logic (1969) through TLA+ at Amazon (2015):
   - 10.1: Hoare Logic — contracts, pre/post conditions
   - 10.2: Dijkstra's Guarded Commands — nondeterminism as a feature
   - 10.3: Abstract Interpretation — sound approximation
   - 10.4: Temporal Logic — from states to traces
   - 10.5: Model Checking — exhaustive but disciplined
   - 10.6: SAT/SMT and Bounded Model Checking — CEGAR, Cobra
   - 10.7: Alloy and the Small Scope Hypothesis
   - 10.8: Refinement Proofs — seL4, CompCert
   - 10.9: Industrial Adoption — TLA+ at Amazon

2. **Part 11: Choosing Your Specification Style** — operational vs axiomatic vs algebraic, with hybrid approach recommendations

3. **Section 2.4**: Two-tier language design (valid-behavior DSL vs adversarial DSL)

4. **Section 5.5**: Soundness vs completeness tradeoffs for checkers

5. **Section 1.3**: Three-layer enforcement separation (static/runtime/semantic)

6. **References**: Expanded with categorized citations (Foundational Papers, Verification Techniques, Industrial Applications)

**Commit**: `0566703` (+625 lines to GUIDE.md)

### Phase 5: Applying Lessons to Our Own Testing

The user then asked: _"let's also again take what we've just learned and review our own testing setup & spec.md that we just made for how we can improve them."_

This produced the most interesting technical work of the project.

**Changes to `history.ts`**:
- Added `CheckerMetadata` interface with soundness/completeness labels
- Created `SERIALIZABILITY_CHECKER` and `SNAPSHOT_ISOLATION_CHECKER` constants
- Updated `ConsistencyCheckResult` to include checker field
- Updated `formatCheckResult()` to display checker info

**Changes to `SPEC.md`**:
- Added Safety vs Liveness section categorizing each property
- Added Specification Shapes section (algebraic, operational, axiomatic)
- Added bidirectional Enforcement Checklist (Doc→Code and Code→Doc tables)
- **Fixed I8 (OTSP Visibility)**: Changed from `≤` to `<` based on what exhaustive testing discovered

**New test files**:

1. **`exhaustive.test.ts`** (153 tests) — Small-scope exhaustive testing based on Alloy's hypothesis:
   - All single-operation scenarios
   - All two-operation same-key scenarios
   - All concurrent transaction pairs
   - Three-way concurrent increments
   - **Complete timestamp boundary testing**: All 30 combinations of `commitTs` (1-5) × `snapshotTs` (0-5)

2. **`adversarial.test.ts`** (20 tests) — Tier 2 raw events DSL:
   - Double commits (C2 violation)
   - Operations after commit/abort (C3 violation)
   - Non-existent transaction operations
   - Duplicate transaction IDs
   - Empty transactions
   - Interleaved multi-transaction operations

3. **`refinement.test.ts`** (10 tests) — Store equivalence verification:
   - Step-by-step comparison of MapStore vs StreamStore
   - Deterministic scenarios (assign, concurrent increments, delete, abort)
   - Fuzz-based refinement with random scenarios

#### The Visibility Boundary Discovery

The most significant finding: exhaustive timestamp boundary testing revealed a spec/implementation discrepancy.

**SPEC.md said**: `T1.commitTs ≤ T2.snapshotTs` → T1 visible to T2
**Implementation did**: `T1.commitTs < T2.snapshotTs` (strict inequality)

A transaction at `snapshotTs=5` does NOT see commits at `commitTs=5`. This is exactly the kind of boundary condition that fuzzing almost never hits (low probability of generating exact boundary values) but exhaustive enumeration finds immediately.

The spec was corrected to match the implementation's strict `<` semantics.

**Commit**: `87ee3ae` (+1,262 lines across 6 files)

### Phase 6: First Case Study (Self-Application)

The user suggested documenting what we'd learned as a case study within the guide itself.

**Added Part 12: Case Study — Applying This Guide to Itself**:
- 12.1: Exhaustive testing found real spec/impl boundary bug
- 12.2: Two-tier DSL pattern in practice (typed builder + raw events)
- 12.3: Bidirectional enforcement checklist pattern
- 12.4: Refinement checking between MapStore and StreamStore
- 12.5: Checker metadata with soundness/completeness labels
- 12.6: Summary table + meta-lesson on synergistic techniques

**Commit**: `e87b23a` (+254 lines to GUIDE.md)

### Phase 7: Deep TLA+ Research

The user asked: _"is there anything we can learn from TLA+?"_

This triggered both manual analysis and a web research agent that fetched and analyzed:
- Amazon's formal methods paper
- Lamport's TLA+ resources
- PlusCal tutorials
- Quint (modern TLA+ alternative)
- FoundationDB's deterministic simulation testing
- Datadog's layered verification approach
- Hilel Wayne's analysis of safety/liveness
- Property-based testing literature

**Added to GUIDE.md**:

**Section 10.10: Deeper TLA+ Lessons** (10 subsections):
- 10.10.1: Init/Next formalism — explicit state machine structure
- 10.10.2: ENABLED predicate — deadlock detection
- 10.10.3: Stuttering steps — refinement with varying step counts
- 10.10.4: Fairness constraints — weak vs strong fairness
- 10.10.5: Invariants vs Temporal properties — what to check when
- 10.10.6: State space explosion and symmetry reduction
- 10.10.7: LTL property patterns — absence, existence, response, precedence, until
- 10.10.8: Assume-guarantee decomposition — per-component contracts
- 10.10.9: Spec composition patterns — and/or/hiding/rename combinators
- 10.10.10: Systematic liveness checking — bounded, ranking, acceptance strategies

**Section 10.11: Industrial Lessons** (5 subsections):
- 10.11.1: The 35-step bug — Amazon's DynamoDB model checker finding + exploration tiers
- 10.11.2: Quint — modern TLA+ with TypeScript vibes, mode-aware specification
- 10.11.3: Deterministic Simulation Testing — FoundationDB's 1-2 customer-bug secret
- 10.11.4: Counterexample minimization — delta debugging for trace shrinking
- 10.11.5: The spec-implementation gap — verification pyramid (Spec → Reference → Production)

**Commits**: `6b347db` (+584 lines), `aeb0689` (+220 lines)

### Phase 8: Webhook DSL Case Study

The user shared a detailed experience report from a team that built a webhook testing DSL using the guide. Their reflections included:

**What worked**: History-based verification ("transformative"), two-tier design ("essential, not optional"), fluent builders (40 lines → 8 lines)

**What was hard**: Timing in async protocols, the "last mile" problem in step implementations, property-based testing integration

**What emerged**: RunContext pattern, invariant checkers as "always-on assertions", DSL as documentation

The user then passed back the team's answers to follow-up questions, providing concrete code:
- The epoch confusion bug fix (respond to pending webhook before done callback)
- The consumedCount pattern (before/after code showing the race condition fix)
- The full `.done()` implementation (6-step orchestration)
- Their timeout heuristic formula

**Added to GUIDE.md**:
- Section 12.7: Webhook DSL Case Study (with concrete code examples)
- Part 13: DSLs for Async and Concurrent Systems (5 sections)
- Part 14: Property-Based Testing with DSLs (5 sections)

**Commits**: `3c426b0` (+438 lines), `e462311` (+113 lines)

### Phase 9: Stream-FS Case Study

The user shared another experience report from a team building a shared filesystem for AI agents (`@durable-streams/stream-fs`). Their results: 95 → 425 tests, 3+ bugs caught, formal specification serving as documentation.

**Three bugs caught**:
1. Path normalization edge case (`//double//slashes.txt`) — found by exhaustive testing
2. Sync vs async method confusion — found by DSL forcing explicit operation semantics
3. Missing ancestor chain validation — found by adversarial constraint testing

**Key insight**: "Writing SPEC.md was the most valuable exercise" — forced precision on ambiguous behaviors like multi-agent consistency semantics

**Added to GUIDE.md**:
- Section 12.8: Stream-FS Case Study
- Part 15: DSL Implementation Patterns (4 sections):
  - 15.1: Modeling sync vs async operations
  - 15.2: Snapshot comparison strategies
  - 15.3: Test performance at scale
  - 15.4: Mutation testing for test quality

**Commit**: `e102d5b` (+501 lines)

---

## Final Artifact: The Guide

The guide grew from ~985 lines to **3,702 lines** across 15 parts:

| Part | Title | Origin |
|------|-------|--------|
| 0 | Why — The Bounded Agents Problem | Session 1 (configurancy blog post) |
| 1 | Start From Formal Foundations | Session 1 (CobbleDB paper) |
| 2 | Design the DSL | Session 1, enhanced in Session 2 (two-tier design) |
| 3 | Algebraic Property Testing | Session 1 (CobbleDB paper) |
| 4 | Fuzz Testing Framework | Session 1 |
| 5 | Jepsen-Inspired Techniques | Session 1, enhanced in Session 2 (soundness/completeness) |
| 6 | Practical Patterns | Session 1, enhanced in Session 2 (bidirectional enforcement) |
| 7 | LLM-Guided Testing | Session 1 |
| 8 | Lessons Learned | Session 1 |
| 9 | Where This Breaks Down | Session 1 |
| 10 | Formal Verification Background | Session 2 (expert review + TLA+ research) |
| 11 | Choosing Your Specification Style | Session 2 (expert review) |
| 12 | Case Studies (3) | Session 2 (self-application, webhook, stream-fs) |
| 13 | DSLs for Async and Concurrent Systems | Session 2 (webhook feedback) |
| 14 | Property-Based Testing with DSLs | Session 2 (webhook feedback) |
| 15 | DSL Implementation Patterns | Session 2 (stream-fs feedback) |

---

## Final Artifact: The Implementation

**522 tests passing** across 9 test files:

| File | Tests | Technique |
|------|-------|-----------|
| `conformance.test.ts` | 82 | Core behavior conformance |
| `merge-properties.test.ts` | 203 | Algebraic CAI property testing |
| `exhaustive.test.ts` | 153 | Small-scope exhaustive (Alloy-style) |
| `fuzz.test.ts` | 20 | Seeded fuzz testing |
| `adversarial.test.ts` | 20 | Tier-2 raw events DSL |
| `history.test.ts` | 12 | Elle-style dependency graphs |
| `http-api.test.ts` | 13 | Batch transaction API |
| `refinement.test.ts` | 10 | Store equivalence verification |
| `spec-vectors.test.ts` | 9 | Paper test vectors TV1-TV7 |

**SPEC.md** (446 lines): 8 affordances, 8+ invariants, 5+ constraints, safety/liveness categorization, specification shapes, enforcement checklist.

**Total txn-spec package**: 15,371 lines across 27 files.

---

## What the Process Revealed

### 1. The Feedback Loop Works

The most productive pattern was: **implement → apply → discover → document → get external feedback → incorporate → repeat**. Each cycle produced genuine insights:

- Implementing the guide's techniques on our own code found a real spec/impl boundary bug
- External teams applying the guide found bugs we hadn't anticipated (async timing, path normalization, sync/async confusion)
- Each case study revealed gaps that became new guide sections

### 2. Exhaustive Small-Scope Testing Is Underrated

The visibility boundary bug (`<` vs `≤`) was invisible to 50 fuzz test runs but immediately obvious to 30 exhaustive timestamp combinations. The small scope hypothesis (Alloy) proved itself: most bugs appear in small counterexamples.

### 3. The Two-Tier DSL Pattern Is Universal

Every case study validated this independently:
- **txn-spec**: Typed scenario builder vs raw event injection
- **Webhook DSL**: Fluent builder vs `callCallback` escape hatch
- **Stream-FS**: Scenario builder vs adversarial constraint tests

The typed builder makes correct tests easy; the raw escape hatch makes adversarial tests possible. Forcing adversarial scenarios through the builder either weakens its type safety or makes it unusable.

### 4. Writing Specifications Is the Highest-Value Activity

Both external teams independently identified SPEC.md as the most valuable exercise:
- Webhook team: History-based verification was "transformative"
- Stream-FS team: "Writing SPEC.md was the most valuable exercise"

The act of specifying invariants and constraints forces clarity on ambiguous behaviors that tests alone cannot provide.

### 5. Async Systems Expose Guide Gaps

The webhook team's feedback revealed that the guide assumed roughly synchronous step execution. Real protocols have timing-dependent behavior where response ordering changes state transitions. This led to three new guide sections (Parts 13-15) that wouldn't have existed without external feedback.

### 6. The Guide Became Self-Improving

By documenting the process (case studies), the guide now contains evidence of its own effectiveness. Future readers can see:
- What techniques were applied
- What bugs they caught
- What was hard in practice
- What patterns emerged

This self-referential quality — a guide that includes case studies of applying itself — makes it more credible than a purely prescriptive document.

---

## Quantitative Summary

| Metric | Value |
|--------|-------|
| Sessions | 2 |
| Commits | 16 |
| Total lines created | 15,371 |
| GUIDE.md final size | 3,702 lines |
| SPEC.md final size | 446 lines |
| Test count | 522 |
| Test files | 9 |
| Source files | 14 |
| Case studies | 3 |
| Guide parts | 15 |
| Bugs found by techniques | 4+ (visibility boundary, path normalization, sync/async confusion, ancestor validation) |
| External feedback rounds | 3 (expert review, webhook team, stream-fs team) |
| Web research queries | ~15 (TLA+, Amazon, Quint, FoundationDB, Datadog, etc.) |

---

## Commit History (Chronological)

```
f086676 feat: add @durable-streams/txn-spec package
8bb8117 feat(txn-spec): expand test suite with comprehensive scenarios
b2d9eb2 feat(txn-spec): add stream-backed store implementation
4710fa0 feat(txn-spec): add batch transaction HTTP API
479934e feat(txn-spec): add fuzz testing framework
6f548e0 fix(txn-spec): correct terminology and add merge CAI property tests
cf88d51 docs(txn-spec): add comprehensive DSL testing guide
6f6efdb docs(txn-spec): expand guide with configurancy concepts
a93f2c7 feat(txn-spec): add formal specification and history-based verification
--- Session 2 begins ---
0566703 docs(txn-spec): incorporate formal verification history review feedback
87ee3ae feat(txn-spec): add exhaustive testing, adversarial DSL, and refinement checking
e87b23a docs(txn-spec): add case study documenting lessons learned
6b347db docs(txn-spec): incorporate formal verification history review feedback (TLA+ deep dive)
aeb0689 docs(txn-spec): add industrial TLA+ lessons from web research
3c426b0 docs(txn-spec): add webhook DSL case study and async/PBT sections
e462311 docs(txn-spec): enrich webhook case study with concrete code examples
e102d5b docs(txn-spec): add Stream-FS case study and implementation patterns
```

---

_This reconstruction was written at the end of Session 2, after all changes were committed and pushed to `claude/pdf-to-markdown-converter-gCfV3`._
