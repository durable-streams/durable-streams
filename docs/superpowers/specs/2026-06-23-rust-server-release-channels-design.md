# Rust server release channels — design

**Date:** 2026-06-23
**Scope:** Publish the Rust Durable Streams server (`packages/server-rust`) to three
distribution channels — crates.io, npm, and prebuilt binary tarballs — driven by a
single git tag. Server only; the `durable-streams-client` crate and any Windows
target are explicitly out of scope.

## Goal & trigger

One git tag — `server-rust-v<X.Y.Z>` — drives all three channels from a single
GitHub Actions workflow. **The source of version truth is `Cargo.toml`'s
`version`.** A first job asserts that the tag version matches `Cargo.toml` and fails
fast on mismatch, so the crate, npm, and binary versions can never drift.

The binary tarball channel already exists (`.github/workflows/release-server-rust.yml`,
triggered by `server-rust-v*`). We **extend that workflow** rather than add a new
file, so the same matrix build feeds all three channels — no second build, no
divergent versions.

## Channel 1 — cargo (crates.io) — NEW

The crate name `durable-streams-server` is **taken on crates.io** by an unrelated
third party. Verified 2026-06-23: `durable-streams` is **free**, `durable-streams-server`
is taken.

Changes to `packages/server-rust/Cargo.toml`:

```toml
[package]
name = "durable-streams"   # was: durable-streams-server

[[bin]]
name = "durable-streams-server"   # binary name UNCHANGED
path = "src/main.rs"
```

- The **binary name stays `durable-streams-server`** → zero breakage. The only
  in-repo reference to the crate _name_ is `Cargo.toml:2`; `src/main.rs:258` is a
  log string (binary name) and stays. The conformance harness, the binary build
  workflow, and the docs all reference the _binary_, not the crate.
- `cargo install durable-streams` therefore installs a `durable-streams-server`
  command. Pairs with the future client crate `durable-streams-client`.
- Regenerate `Cargo.lock` after the rename.

Workflow: a `cargo-publish` job on a linux runner authenticates via **crates.io
Trusted Publishing (OIDC)** — `rust-lang/crates-io-auth-action` exchanges the
workflow's OIDC token for a short-lived (~30-min) crates.io token, then
`cargo publish --locked`. No long-lived `CARGO_REGISTRY_TOKEN` secret. `cargo publish`
runs its own verify-build, so the step is self-checking. The job needs
`permissions: id-token: write`. It depends on `assert-version`; it does **not** need
the cross-built binaries (cargo builds for the host), so it can run in parallel with
the binary matrix. (See **Bootstrap** below — the crate must exist and have a trusted
publisher configured before OIDC works.)

## Channel 2 — npm — NEW

Pattern: **esbuild / swc / biome multi-package `optionalDependencies`** — the
ecosystem-standard approach (chosen over a single bundled package or a postinstall
download; pnpm 11.2 re-affirmed this pattern as the blessed path). Rationale: npm
resolves platform selection natively via `os`/`cpu`/`libc`, each user downloads only
their own binary, and there is no postinstall script to break under `--ignore-scripts`
or corporate proxies.

The npm scope `@durable-streams` is in use; `@durable-streams/server` is already the
TypeScript dev server, so the Rust server takes a distinct name.

### Main package — `@durable-streams/server-rust`

- No `os`/`cpu` restriction.
- `optionalDependencies` lists all 4 platform packages (pinned to the exact release
  version).
- `bin: { "durable-streams-server": "bin/launcher.js" }` → a tiny JS launcher (no
  postinstall) that `require.resolve`s the matching platform package's binary and
  `execFileSync`s it, forwarding argv/stdio and propagating the exit code. The
  node-wrapper overhead is irrelevant for a long-running server.
- Ships the README.

### 4 platform packages

Each contains one binary + a `package.json` with `os`/`cpu` (and `libc` for the
linux gnu builds), mapped from the existing build matrix:

| npm platform package                        | Rust target                 |
| ------------------------------------------- | --------------------------- |
| `@durable-streams/server-rust-linux-x64`    | `x86_64-unknown-linux-gnu`  |
| `@durable-streams/server-rust-linux-arm64`  | `aarch64-unknown-linux-gnu` |
| `@durable-streams/server-rust-darwin-x64`   | `x86_64-apple-darwin`       |
| `@durable-streams/server-rust-darwin-arm64` | `aarch64-apple-darwin`      |

### Source layout & build

Committed source lives in `packages/server-rust/npm/`:

- `package.json` template for the main package + `bin/launcher.js`.
- A `package.json` template for the platform packages (single template,
  parameterized per target).

The `npm-publish` job (depends on the binary matrix, so the 4 binaries exist):

1. Stamp the release version into all 5 manifests (main + 4 platform), and pin the
   `optionalDependencies` to that version.
2. Drop each built binary into its platform package, `chmod +x`.
3. `npm publish` the **4 platform packages first**, then the **main package last**
   (the main package's optionalDeps must already resolve on the registry).

Auth: **npm Trusted Publishing (OIDC)** — no `NODE_AUTH_TOKEN` / `NPM_TOKEN`. The
job needs `permissions: id-token: write` and npm CLI **≥ 11.5.1** (the runner's
bundled npm is older, so `npm install -g npm@latest` first). Provenance attestations
come for free with OIDC. (See **Bootstrap** below — npm requires each package to
already exist before a trusted publisher can be configured, so the 5 packages need a
one-time token-based first publish.)

## Channel 3 — prebuilt binary tarballs — EXISTS (light polish)

`release-server-rust.yml` already builds all 4 targets natively, smoke-tests each
(`/health`), and attaches `.tar.gz` + `.sha256` to a GitHub Release on the tag.

This stays as the foundation; the cargo and npm jobs are added to the same workflow
and reuse its built artifacts. Optional, deferrable polish: a `curl | sh`
`install.sh` that detects platform and pulls the right tarball. Not required for the
first release.

## Resulting workflow shape (`.github/workflows/release-server-rust.yml`)

Triggered by `server-rust-v*`:

The whole workflow declares `permissions: { contents: write, id-token: write }`
(id-token for OIDC; contents for the Release upload).

1. **`assert-version`** — tag version `== Cargo.toml` version, else fail.
2. **`create-release`** — GitHub Release (idempotent), as today.
3. **`build`** (matrix, 4 targets) — build `--locked` + smoke test + upload
   tarball/checksum to the Release. As today; `needs: [assert-version, create-release]`.
4. **`cargo-publish`** — `rust-lang/crates-io-auth-action` (OIDC) → `cargo publish
   --locked` (linux). `needs: assert-version`; parallel with `build`. No token secret.
5. **`npm-publish`** — `npm install -g npm@latest`, assemble 5 packages from the
   built binaries, publish platform packages then main via OIDC. `needs: build`. No
   token secret.

## Bootstrap (one-time, maintainer-only)

Trusted publishing on both registries requires the package/crate to **already exist**
before a trusted publisher can be attached (npm/cli#8544 is still open; crates.io
requires crate ownership). So the very first release is bootstrapped manually, after
which the committed workflow is **token-free**:

1. **crates.io:** sign in, **verify email**, create a scoped API token, `cargo login`,
   `cargo publish` the `durable-streams` crate once. Then:
   - **Org ownership** — the crate is owned by the **electric-sql** org (the repo
     lives under the separate `durable-streams` GitHub org, but crate ownership and
     the trusted-publisher repo are independent, so this asymmetry is fine).
     Prerequisite: grant crates.io the `read:org` scope for electric-sql
     (GitHub → Settings → Applications → crates.io → Organization access → Grant —
     **done**). Owning team is **`electric-sql:core`**. Then
     `cargo owner --add github:electric-sql:core`. **Keep a named individual owner**
     (you) — team owners cannot manage owners or the trusted publisher.
   - **Trusted Publisher** — in the crate's crates.io settings add the repo
     `durable-streams/durable-streams` + workflow `release-server-rust.yml`
     (environment optional — skip to avoid needing repo-admin); optionally enforce
     trusted-publishing-only. Revoke the bootstrap token.
2. **npm:** with a granular automation token, publish all **5** packages once
   (`@durable-streams/server-rust` + the 4 platform packages). Then on npmjs.com
   configure a Trusted Publisher for **each** of the 5 (GitHub repo + workflow file).
   Revoke the token.

From the second release onward, pushing a `server-rust-v*` tag publishes all three
channels with **no stored secrets**.

## Testing / verification

- `cargo publish --dry-run --locked` from `packages/server-rust/` after the rename
  (verifies the crate packages cleanly under the new name).
- `cargo package --list` to confirm the file set.
- Local smoke of the npm launcher: build one binary, place it in a fake platform
  package under `node_modules`, run the launcher, assert it execs and forwards
  args/exit code.
- The existing per-target `/health` smoke test in the `build` job continues to gate
  shipped binaries.
- First real release performed against a pre-release tag (e.g. `server-rust-v0.1.0`)
  and verified: `cargo install durable-streams`, `npm i -g @durable-streams/server-rust`,
  and a tarball download each yield a working `durable-streams-server`.

## Out of scope

- `durable-streams-client` crate / npm publishing.
- Windows targets (the server relies on Unix-only syscalls: `libc`, `sendfile`,
  `F_FULLFSYNC`).
- Docker/OCI container images (the user's "binary images" meant prebuilt tarballs).
- Resolving the repo-root MIT-vs-Apache `LICENSE` contradiction (pre-existing,
  deferred).
