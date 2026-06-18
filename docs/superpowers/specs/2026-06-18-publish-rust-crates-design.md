# Design: Publish the Rust server and client to crates.io

**Date:** 2026-06-18
**Status:** Approved (brainstorming) — pending spec review
**Worktree/branch:** `worktree-publish-rust-crates` (branched from `vbalegas/streams-rust` HEAD)

## Background

Two Rust packages live in the monorepo and are not yet published to crates.io:

- `packages/server-rust` — a **binary** crate (the high-performance Durable Streams
  server). Currently named `durable-streams-server` v0.1.0.
- `packages/client-rust` — a **library** crate (the Rust client). Currently named
  `durable-streams` v0.1.0, with a test-only `conformance-adapter` binary.

The goal is to publish both so the server is `cargo install`-able and the client is
`cargo add`-able. This is the maintainer's first crates.io publish.

The maintainer is **concurrently refactoring the server source**, so this work must be
**merge-safe**: it touches only manifests / ignore files / a test script — **zero edits
to any `src/*.rs`** — so the two efforts rebase past each other cleanly.

## Goals

- Publish `packages/server-rust` as a binary crate (`cargo install …` runs the server).
- Publish `packages/client-rust` as a library crate (`cargo add …` for downstream use).
- Keep all changes confined to non-source files for merge safety.

## Non-goals (explicit follow-ups, not this effort)

- CI publish-on-tag automation (GitHub Action).
- Resolving the repo-wide license contradiction (see License section).
- Splitting the server into `lib` + `bin` — maintainer chose binary-only.
- Publishing any other package (Caddy plugin, TS packages, etc.).

## Key findings that shaped the design

1. **`durable-streams-server` is already taken** on crates.io by a third party
   (`thesampaton`, an independent axum-based implementation, versions up to 0.3.0).
   We cannot publish under that name.
2. **`durable-streams`, `durable-streams-client` are both free** on crates.io.
3. **The client crate already claims the bare name `durable-streams`** in its manifest.
   The chosen allocation is therefore a *swap*.
4. **License inconsistency exists repo-wide**: the root `LICENSE` file is MIT, but every
   package manifest (14+ incl. the TS client, TS server, Caddy plugin, CLI, and the Rust
   server) declares `Apache-2.0`. The lone Rust outlier is the client (`MIT OR Apache-2.0`).
   The project's *intended* license is clearly Apache-2.0; the MIT `LICENSE` file is the
   stray. **Decision: do not touch the repo base LICENSE in this effort.**
5. **Client `target/` is committed to git** (force-added; root `.gitignore` line 186 already
   ignores `target/`). cargo auto-excludes `target/` from the package, so it does not ship,
   but it is repo bloat worth untracking.
6. **Client `base64` is a real library dependency** — used by `src/iterator.rs` (decoding
   base64-encoded payloads), not just the conformance-adapter binary. (An initial check
   suggested it was bin-only; that was a false negative from a shell globbing error, caught
   by the verification build.) So `base64` must stay a required dependency, and the bin is
   left as a normal (ungated) target.
7. **Renaming the client package breaks its in-repo import.** The library is referenced as
   `durable_streams` in 15 places (the `conformance-adapter` bin, `lib.rs`/`types.rs`
   doctests, and 4 README examples). Renaming the package to `durable-streams-client` would
   change the default library name and break all of them. Resolved with `[lib] name =
   "durable_streams"` — the crate publishes as `durable-streams-client` but stays importable
   as `durable_streams`, with zero source/doc edits.
8. **No `test:run:rust` script is wired into the conformance runner** (only elixir/python
   are). The rust adapter is run manually via `run-conformance-adapter.sh`, which execs a
   pre-built `target/release/conformance-adapter` — left unchanged.

## Decisions

### Naming

| Package | Current name | New name | Kind | Entry point |
|---|---|---|---|---|
| `packages/server-rust` | `durable-streams-server` (taken) | **`durable-streams`** | binary | `cargo install durable-streams` → command `durable-streams` |
| `packages/client-rust` | `durable-streams` | **`durable-streams-client`** | library | `cargo add durable-streams-client` |

- The server's installed **command** stays `durable-streams` (default = crate name; no
  `[[bin]]` override). Confirmed by maintainer.
- Allocating the bare name to the binary is slightly unconventional (the bare name is
  usually a library) but is a deliberate, maintainer-confirmed choice.

### License

- Root `LICENSE` file (MIT): **untouched**. The repo-wide MIT-vs-Apache contradiction is
  explicitly deferred.
- Server: `license = "Apache-2.0"` — **no change** (already correct).
- Client: `license = "MIT OR Apache-2.0"` → **`"Apache-2.0"`** (match the rest of the repo).
- **No `LICENSE` file copied into the crate dirs.** Copying the root MIT text would
  contradict the `Apache-2.0` SPDX field; cargo only needs the `license =` field to publish.
  The pre-existing repo-level contradiction is documented and deferred.

### Scope

Both crates are prepared and published in this effort. They do not depend on each other, so
publish order is irrelevant.

## Detailed changes (all non-source)

### A. `packages/server-rust/Cargo.toml`

- `name = "durable-streams-server"` → `name = "durable-streams"`
- Add `keywords = ["durable-streams", "streaming", "event-sourcing", "http", "append-only-log"]`
  (5 max, each ≤20 chars — valid).
- Add `categories = ["network-programming", "web-programming::http-server"]` (valid crates.io
  category slugs).
- Add `exclude = ["conformance"]` (drop the 8 KB of TypeScript conformance tests from the
  package). Keep `README.md`, `ARCHITECTURE.md`, `BENCHMARKS.md` (README links to
  `./BENCHMARKS.md`).
- `license`, `description`, `repository`, `homepage`, `readme`, `rust-version` unchanged.

### B. `packages/client-rust/Cargo.toml`

- `name = "durable-streams"` → `name = "durable-streams-client"`
- `license = "MIT OR Apache-2.0"` → `license = "Apache-2.0"`
- Add a `[lib]` section with `name = "durable_streams"` so the published crate
  (`durable-streams-client`) stays importable as `durable_streams` (see finding #7) — keeps
  all 15 `durable_streams` call sites/doctests/README examples valid with no source edits.
- Add `exclude = ["design.md", "run-conformance-adapter.sh"]`.
- `base64` stays a **required** dependency (the library uses it — finding #6).
- The `conformance-adapter` binary is left as a normal, ungated target. It still ships in the
  package (a ~1.3k-line test adapter) but is harmless; it is not worth feature-gating given
  `base64` can't be removed from the library anyway.

cargo regenerates the client `Cargo.lock` (only the package-name rename plus a lockfile
format bump `version = 3` → `4`, matching the server's already-v4 lock).

### C. Untrack the client `target/`

`git rm -r --cached packages/client-rust/target` — the root `.gitignore` already ignores
`target/`, so no new ignore file is needed. `run-conformance-adapter.sh` is left unchanged
(the bin is ungated, so the existing pre-built-exec flow still works).

## Verification

In the worktree, before any publish (all run and **passing**):

1. `cargo package --list` in each crate — confirms the exact shipped file set: server
   excludes `conformance/`; client excludes `design.md`, `run-conformance-adapter.sh`, and
   `target/` (auto-excluded). The client's `conformance-adapter` source still ships.
2. `cargo publish --dry-run` in **`packages/client-rust`** — lib + bin compile (only
   pre-existing `unused_mut` warnings), reaches the upload/abort step. ✓
3. `cargo publish --dry-run` in **`packages/server-rust`** — `durable-streams v0.1.0`
   compiles, reaches the upload/abort step. ✓

## Publish runbook (who does what)

**Me (in the worktree):** all edits A–C above; run the full Verification list; report the
`cargo package --list` and `--dry-run` output.

**Maintainer (account & secrets — cannot/should not be automated):**
1. Sign in to crates.io with GitHub.
2. **Verify account email** (required before any publish).
3. Generate a scoped API token (Account Settings → API Tokens; scope to publish-new +
   publish-update; optionally restrict to the two crate names).
4. `cargo login` (or export `CARGO_REGISTRY_TOKEN`).

**Final publish** (irreversible & public): `cargo publish` per crate, run by the maintainer
(or explicitly authorized after login). Optionally `cargo owner --add <org/team>` afterward
for shared ownership.

## Merge-safety summary

Files touched: `packages/server-rust/{Cargo.toml,Cargo.lock}`,
`packages/client-rust/{Cargo.toml,Cargo.lock}`, and untracking
`packages/client-rust/target/`. **No `src/*.rs` is modified**, so the maintainer's parallel
server refactor and this work are disjoint and rebase cleanly. (`run-conformance-adapter.sh`
was ultimately left unchanged.)
