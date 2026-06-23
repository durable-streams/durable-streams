# Rust server release channels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Rust Durable Streams server to crates.io, npm, and prebuilt binary tarballs from a single `server-rust-v*` git tag, with no long-lived registry secrets (OIDC trusted publishing).

**Architecture:** One GitHub Actions workflow (`release-server-rust.yml`, extended from the existing binary-release workflow) is the single entry point. A version-assertion job pins the tag to `Cargo.toml`. The existing 4-target build matrix feeds three publish paths: tarballs to the GitHub Release (as today), `cargo publish` via crates.io trusted publishing, and a Node-assembled set of 5 npm packages (esbuild-style `optionalDependencies` platform packages) via npm trusted publishing.

**Tech Stack:** Rust/Cargo, GitHub Actions, Node.js (built-in `node --test`, no new deps), npm CLI ≥ 11.5.1, `rust-lang/crates-io-auth-action`.

## Global Constraints

- Crate name: **`durable-streams`**; binary name stays **`durable-streams-server`** (via `[[bin]]`). License **`Apache-2.0`**.
- npm main package: **`@durable-streams/server-rust`**; 4 platform packages `@durable-streams/server-rust-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`.
- The 4 targets and their npm platform mapping:
  - `x86_64-unknown-linux-gnu` → `linux-x64` (libc glibc)
  - `aarch64-unknown-linux-gnu` → `linux-arm64` (libc glibc)
  - `x86_64-apple-darwin` → `darwin-x64`
  - `aarch64-apple-darwin` → `darwin-arm64`
- Version source of truth: `packages/server-rust/Cargo.toml` `version`. Tag form `server-rust-v<X.Y.Z>` must equal it.
- Both registries publish via **OIDC trusted publishing** — the committed workflow stores **no** registry tokens. Workflow needs `permissions: { contents: write, id-token: write }`.
- Crate ownership: owned by `electric-sql:core` + a named individual owner; trusted publisher repo `durable-streams/durable-streams`, workflow `release-server-rust.yml`. (Bootstrap is a one-time manual runbook, not automated — see the spec.)
- Node scripts under `packages/server-rust/npm/` use only the Node standard library (no dependencies, no bundler). pnpm's workspace glob is `packages/*` (one level), so these files are NOT workspace packages — do not add them to `pnpm-workspace.yaml`.
- Server only. No Windows targets. No Docker images.

Spec: `docs/superpowers/specs/2026-06-23-rust-server-release-channels-design.md`.

---

## File structure

- `packages/server-rust/Cargo.toml` — crate rename + `[[bin]]` (Task 1).
- `packages/server-rust/Cargo.lock` — regenerated (Task 1).
- `packages/server-rust/npm/targets.json` — single source of truth for the 4 targets, consumed by launcher + assembler (Task 2).
- `packages/server-rust/npm/bin/launcher.js` — runtime shim the main package's `bin` points at (Task 2).
- `packages/server-rust/npm/templates/main.package.json` — main-package manifest template (Task 3).
- `packages/server-rust/npm/templates/platform.package.json` — platform-package manifest template (Task 3).
- `packages/server-rust/npm/assemble.mjs` — builds the 5 publish-ready package dirs from built binaries + version (Task 3).
- `packages/server-rust/npm/README.md` — README shipped with the main npm package (Task 3).
- `packages/server-rust/npm/test/launcher.test.mjs`, `assemble.test.mjs` — `node --test` suites (Tasks 2, 3).
- `.github/workflows/release-server-rust.yml` — extended workflow (Task 4).
- `packages/server-rust/README.md` — install instructions for all 3 channels (Task 5).
- `docs/superpowers/runbooks/server-rust-release-bootstrap.md` — one-time bootstrap runbook (Task 5).

---

## Task 1: Rename the crate, keep the binary name

**Files:**
- Modify: `packages/server-rust/Cargo.toml:1-11`
- Modify: `packages/server-rust/Cargo.lock` (regenerated)

**Interfaces:**
- Produces: a crate named `durable-streams` that still builds a binary named `durable-streams-server` at `packages/server-rust/target/<target>/release/durable-streams-server`. Later tasks (workflow, assembler) depend on that exact binary path/name.

- [ ] **Step 1: Edit `Cargo.toml` — rename package and pin the binary name**

Change the `[package]` `name` and add a `[[bin]]` section. The top of the file becomes:

```toml
[package]
name = "durable-streams"
version = "0.1.0"
edition = "2021"
description = "High-performance Durable Streams server (Rust)"
license = "Apache-2.0"
# CI builds on stable; this documents the supported minimum.
rust-version = "1.75"
repository = "https://github.com/durable-streams/durable-streams"
homepage = "https://electric-sql.com/primitives/durable-streams"
readme = "README.md"

# The crate is named `durable-streams` (the bare crate name `durable-streams-server`
# is taken on crates.io), but the produced binary keeps its historical name so the
# conformance harness, release workflow, and docs are unaffected.
[[bin]]
name = "durable-streams-server"
path = "src/main.rs"
```

(Leave the rest of the file — `[dependencies]`, `[features]`, `[profile.release]` — unchanged.)

- [ ] **Step 2: Regenerate the lockfile**

Run: `cd packages/server-rust && cargo generate-lockfile`
Expected: `Cargo.lock` updates the root package entry to `name = "durable-streams"`. Confirm:

Run: `grep -A1 '^name = "durable-streams"' packages/server-rust/Cargo.lock | head -2`
Expected: shows `name = "durable-streams"` (NOT `durable-streams-server`).

- [ ] **Step 3: Verify the build still produces the same binary name**

Run: `cd packages/server-rust && cargo build --release --locked`
Expected: success; binary exists:

Run: `test -x packages/server-rust/target/release/durable-streams-server && echo OK`
Expected: `OK`

- [ ] **Step 4: Verify the crate packages cleanly under the new name**

Run: `cd packages/server-rust && cargo publish --dry-run --locked --allow-dirty`
Expected: ends with `Packaging durable-streams v0.1.0` / `Verifying durable-streams v0.1.0` and no errors. (Network access to crates.io index required; if the sandbox blocks it, note that and run `cargo package --list` instead to confirm the file set.)

- [ ] **Step 5: Commit**

```bash
git add packages/server-rust/Cargo.toml packages/server-rust/Cargo.lock
git commit -m "build(server-rust): rename crate to durable-streams, keep binary name"
```

---

## Task 2: npm runtime launcher + target map

**Files:**
- Create: `packages/server-rust/npm/targets.json`
- Create: `packages/server-rust/npm/bin/launcher.js`
- Test: `packages/server-rust/npm/test/launcher.test.mjs`

**Interfaces:**
- Produces: `targets.json` — a JSON array of `{ node, pkg, rustTarget, os, cpu, libc? }` objects, the single source of truth for the 4 platforms. Consumed by `launcher.js` (Task 2) and `assemble.mjs` (Task 3).
- Produces: `bin/launcher.js` — a CommonJS executable that resolves the platform package for the host and execs `bin/durable-streams-server` inside it, forwarding argv/stdio and propagating the exit code. The main package's `bin` field (Task 3) points at it.

- [ ] **Step 1: Create the target map**

Create `packages/server-rust/npm/targets.json`:

```json
[
  { "node": "linux-x64",   "pkg": "@durable-streams/server-rust-linux-x64",   "rustTarget": "x86_64-unknown-linux-gnu",  "os": "linux",  "cpu": "x64",   "libc": "glibc" },
  { "node": "linux-arm64", "pkg": "@durable-streams/server-rust-linux-arm64", "rustTarget": "aarch64-unknown-linux-gnu", "os": "linux",  "cpu": "arm64", "libc": "glibc" },
  { "node": "darwin-x64",  "pkg": "@durable-streams/server-rust-darwin-x64",  "rustTarget": "x86_64-apple-darwin",       "os": "darwin", "cpu": "x64" },
  { "node": "darwin-arm64","pkg": "@durable-streams/server-rust-darwin-arm64","rustTarget": "aarch64-apple-darwin",      "os": "darwin", "cpu": "arm64" }
]
```

- [ ] **Step 2: Write the failing launcher test**

Create `packages/server-rust/npm/test/launcher.test.mjs`. It builds a fake platform package in a temp dir, points Node's module resolution at it via `NODE_PATH`, and runs the launcher as a child process — asserting it execs the fake binary, forwards args, and propagates the exit code.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "bin", "launcher.js");
const targets = JSON.parse(readFileSync(join(here, "..", "targets.json"), "utf8"));

function fakePlatformPackageRoot() {
  // Build node_modules/<pkg>/{package.json,bin/durable-streams-server} for THIS host.
  const hostKey = `${process.platform}-${process.arch}`;
  const t = targets.find((t) => t.node === hostKey);
  assert.ok(t, `test host ${hostKey} not in targets.json`);
  const root = mkdtempSync(join(tmpdir(), "ds-npm-"));
  const pkgDir = join(root, "node_modules", t.pkg);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: t.pkg, version: "0.0.0" }));
  // A fake "binary" that is really a shell script: echoes args, exits 7.
  const bin = join(pkgDir, "bin", "durable-streams-server");
  writeFileSync(bin, `#!/bin/sh\necho "ARGS:$*"\nexit 7\n`);
  chmodSync(bin, 0o755);
  return root;
}

test("launcher execs the platform binary, forwards args, propagates exit code", () => {
  const root = fakePlatformPackageRoot();
  let out = "", code = 0;
  try {
    out = execFileSync("node", [launcher, "--port", "4438"], {
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
      encoding: "utf8",
    });
  } catch (e) {
    code = e.status;
    out = e.stdout?.toString() ?? "";
  }
  assert.equal(code, 7, "exit code propagated");
  assert.match(out, /ARGS:--port 4438/, "args forwarded");
});

test("launcher errors clearly when no platform package is installed", () => {
  const empty = mkdtempSync(join(tmpdir(), "ds-npm-empty-"));
  let stderr = "", code = 0;
  try {
    execFileSync("node", [launcher], {
      env: { ...process.env, NODE_PATH: join(empty, "node_modules") },
      encoding: "utf8",
    });
  } catch (e) {
    code = e.status;
    stderr = e.stderr?.toString() ?? "";
  }
  assert.notEqual(code, 0);
  assert.match(stderr, /platform package/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test packages/server-rust/npm/test/launcher.test.mjs`
Expected: FAIL — `launcher.js` does not exist (module/file not found).

- [ ] **Step 4: Implement the launcher**

Create `packages/server-rust/npm/bin/launcher.js`:

```js
#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const targets = require("../targets.json");
const key = `${process.platform}-${process.arch}`;
const target = targets.find((t) => t.node === key);

if (!target) {
  const supported = targets.map((t) => t.node).join(", ");
  console.error(
    `durable-streams-server: unsupported platform "${key}". Supported: ${supported}.`
  );
  process.exit(1);
}

let binary;
try {
  // Resolve via package.json (always resolvable) then join the known binary path.
  const pkgJson = require.resolve(`${target.pkg}/package.json`);
  binary = path.join(path.dirname(pkgJson), "bin", "durable-streams-server");
} catch {
  console.error(
    `durable-streams-server: the platform package "${target.pkg}" is not installed.\n` +
      `It should have been installed automatically as an optional dependency. ` +
      `If you used --no-optional or --ignore-optional, reinstall without it.`
  );
  process.exit(1);
}

try {
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  // execFileSync throws on non-zero exit; mirror the child's exit code.
  process.exit(typeof err.status === "number" ? err.status : 1);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test packages/server-rust/npm/test/launcher.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/server-rust/npm/targets.json packages/server-rust/npm/bin/launcher.js packages/server-rust/npm/test/launcher.test.mjs
git commit -m "feat(server-rust/npm): platform launcher + target map"
```

---

## Task 3: npm package assembler

**Files:**
- Create: `packages/server-rust/npm/templates/main.package.json`
- Create: `packages/server-rust/npm/templates/platform.package.json`
- Create: `packages/server-rust/npm/README.md`
- Create: `packages/server-rust/npm/assemble.mjs`
- Test: `packages/server-rust/npm/test/assemble.test.mjs`

**Interfaces:**
- Consumes: `targets.json` and `bin/launcher.js` from Task 2; built binaries named `durable-streams-server` located under `<binsDir>/<rustTarget>/durable-streams-server`.
- Produces: `assemble.mjs` — a CLI: `node assemble.mjs --version <X.Y.Z> --bins <dir> --out <dir>`. It writes `<out>/main/` (the main package) and `<out>/<rustTarget>/` (one per platform package), each a publish-ready directory. Exposes `assemble({ version, binsDir, outDir })` as a named export for tests. The workflow (Task 4) calls the CLI and then `npm publish` in each produced dir (platform dirs first, `main` last).

- [ ] **Step 1: Create the manifest templates**

Create `packages/server-rust/npm/templates/main.package.json` (placeholders `0.0.0` are replaced at assemble time; `optionalDependencies` is filled from `targets.json`):

```json
{
  "name": "@durable-streams/server-rust",
  "version": "0.0.0",
  "description": "High-performance Durable Streams server (Rust) — native binary distributed via npm.",
  "license": "Apache-2.0",
  "homepage": "https://electric-sql.com/primitives/durable-streams",
  "repository": { "type": "git", "url": "https://github.com/durable-streams/durable-streams.git", "directory": "packages/server-rust" },
  "bin": { "durable-streams-server": "bin/launcher.js" },
  "files": ["bin/launcher.js", "targets.json", "README.md"],
  "optionalDependencies": {}
}
```

Create `packages/server-rust/npm/templates/platform.package.json` (`name`, `version`, `os`, `cpu`, and optional `libc` are filled per target):

```json
{
  "name": "",
  "version": "0.0.0",
  "description": "Durable Streams server (Rust) — prebuilt binary for one platform. Installed automatically by @durable-streams/server-rust.",
  "license": "Apache-2.0",
  "homepage": "https://electric-sql.com/primitives/durable-streams",
  "repository": { "type": "git", "url": "https://github.com/durable-streams/durable-streams.git", "directory": "packages/server-rust" },
  "files": ["bin/durable-streams-server"],
  "os": [],
  "cpu": []
}
```

- [ ] **Step 2: Create the npm README**

Create `packages/server-rust/npm/README.md`:

```markdown
# @durable-streams/server-rust

The [Durable Streams](https://github.com/durable-streams/durable-streams) server — a single self-contained Rust binary — distributed via npm.

```bash
npm install -g @durable-streams/server-rust
durable-streams-server --port 4438 --data-dir ./data
```

The correct prebuilt binary for your platform is installed automatically as an optional dependency (Linux/macOS, x64/arm64). See the [server README](https://github.com/durable-streams/durable-streams/tree/main/packages/server-rust) for usage and flags.

Licensed under Apache-2.0.
```

- [ ] **Step 3: Write the failing assembler test**

Create `packages/server-rust/npm/test/assemble.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../assemble.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const targets = JSON.parse(readFileSync(join(here, "..", "targets.json"), "utf8"));

function makeBins() {
  const dir = mkdtempSync(join(tmpdir(), "ds-bins-"));
  for (const t of targets) {
    mkdirSync(join(dir, t.rustTarget), { recursive: true });
    writeFileSync(join(dir, t.rustTarget, "durable-streams-server"), `bin:${t.rustTarget}`);
  }
  return dir;
}

test("assemble produces main + 4 platform packages with stamped versions", () => {
  const binsDir = makeBins();
  const outDir = mkdtempSync(join(tmpdir(), "ds-out-"));
  assemble({ version: "1.2.3", binsDir, outDir });

  // main package
  const main = JSON.parse(readFileSync(join(outDir, "main", "package.json"), "utf8"));
  assert.equal(main.name, "@durable-streams/server-rust");
  assert.equal(main.version, "1.2.3");
  assert.equal(Object.keys(main.optionalDependencies).length, targets.length);
  for (const t of targets) assert.equal(main.optionalDependencies[t.pkg], "1.2.3");
  assert.ok(existsSync(join(outDir, "main", "bin", "launcher.js")));
  assert.ok(existsSync(join(outDir, "main", "targets.json")));
  assert.ok(existsSync(join(outDir, "main", "README.md")));

  // platform packages
  for (const t of targets) {
    const pj = JSON.parse(readFileSync(join(outDir, t.rustTarget, "package.json"), "utf8"));
    assert.equal(pj.name, t.pkg);
    assert.equal(pj.version, "1.2.3");
    assert.deepEqual(pj.os, [t.os]);
    assert.deepEqual(pj.cpu, [t.cpu]);
    if (t.libc) assert.deepEqual(pj.libc, [t.libc]);
    else assert.equal(pj.libc, undefined);
    const binPath = join(outDir, t.rustTarget, "bin", "durable-streams-server");
    assert.ok(existsSync(binPath));
    assert.equal(readFileSync(binPath, "utf8"), `bin:${t.rustTarget}`);
    assert.ok(statSync(binPath).mode & 0o111, "binary is executable");
  }
});

test("assemble throws if a target binary is missing", () => {
  const binsDir = mkdtempSync(join(tmpdir(), "ds-bins-empty-"));
  const outDir = mkdtempSync(join(tmpdir(), "ds-out-"));
  assert.throws(() => assemble({ version: "1.2.3", binsDir, outDir }), /missing binary/i);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test packages/server-rust/npm/test/assemble.test.mjs`
Expected: FAIL — cannot import `assemble` from `../assemble.mjs` (file not found).

- [ ] **Step 5: Implement the assembler**

Create `packages/server-rust/npm/assemble.mjs`:

```js
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

export function assemble({ version, binsDir, outDir }) {
  if (!version) throw new Error("assemble: version is required");
  const targets = readJson(join(here, "targets.json"));
  const mainTpl = readJson(join(here, "templates", "main.package.json"));
  const platTpl = readJson(join(here, "templates", "platform.package.json"));

  // Platform packages.
  const optionalDependencies = {};
  for (const t of targets) {
    const src = join(binsDir, t.rustTarget, "durable-streams-server");
    if (!existsSync(src)) throw new Error(`assemble: missing binary for ${t.rustTarget} at ${src}`);
    const pkgDir = join(outDir, t.rustTarget);
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    const dest = join(pkgDir, "bin", "durable-streams-server");
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);

    const pj = { ...platTpl, name: t.pkg, version, os: [t.os], cpu: [t.cpu] };
    if (t.libc) pj.libc = [t.libc];
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pj, null, 2) + "\n");
    optionalDependencies[t.pkg] = version;
  }

  // Main package.
  const mainDir = join(outDir, "main");
  rmSync(mainDir, { recursive: true, force: true });
  mkdirSync(join(mainDir, "bin"), { recursive: true });
  copyFileSync(join(here, "bin", "launcher.js"), join(mainDir, "bin", "launcher.js"));
  copyFileSync(join(here, "targets.json"), join(mainDir, "targets.json"));
  copyFileSync(join(here, "README.md"), join(mainDir, "README.md"));
  const mainPj = { ...mainTpl, version, optionalDependencies };
  writeFileSync(join(mainDir, "package.json"), JSON.stringify(mainPj, null, 2) + "\n");

  return { mainDir, platformDirs: targets.map((t) => ({ target: t, dir: join(outDir, t.rustTarget) })) };
}

// CLI: node assemble.mjs --version X.Y.Z --bins <dir> --out <dir>
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "");
    out[k] = argv[i + 1];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  const res = assemble({ version: a.version, binsDir: a.bins, outDir: a.out });
  // Print platform dirs first, main last — the publish order.
  for (const p of res.platformDirs) console.log(p.dir);
  console.log(res.mainDir);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test packages/server-rust/npm/test/assemble.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 7: Smoke the CLI end-to-end against a real binary**

Run:
```bash
cd packages/server-rust
mkdir -p /tmp/ds-bins/$(rustc -vV | sed -n 's/host: //p')
cp target/release/durable-streams-server /tmp/ds-bins/$(rustc -vV | sed -n 's/host: //p')/
node npm/assemble.mjs --version 0.1.0 --bins /tmp/ds-bins --out /tmp/ds-out 2>/dev/null || true
ls /tmp/ds-out/main/package.json && echo "main package assembled"
```
Expected: prints `main package assembled` (only the host target's platform package will be fully populated here; the assembler errors on missing targets, so this step just confirms the host path works — the real multi-target run happens in CI).

Note: because `assemble` requires ALL four binaries, the single-binary smoke will throw on the first missing target. To smoke just the host, temporarily run the unit test (Step 6) which already exercises all four via fakes. This step is optional confirmation only.

- [ ] **Step 8: Commit**

```bash
git add packages/server-rust/npm/templates packages/server-rust/npm/README.md packages/server-rust/npm/assemble.mjs packages/server-rust/npm/test/assemble.test.mjs
git commit -m "feat(server-rust/npm): package assembler (5 publish-ready dirs)"
```

---

## Task 4: Extend the release workflow (version gate + cargo + npm via OIDC)

**Files:**
- Modify: `.github/workflows/release-server-rust.yml` (full rewrite, preserving the existing build/release behavior)

**Interfaces:**
- Consumes: the binary at `packages/server-rust/target/<target>/release/durable-streams-server` (Task 1); `assemble.mjs` + `targets.json` (Tasks 2-3).
- Produces: nothing for later tasks — this is the automation entry point.

- [ ] **Step 1: Rewrite the workflow**

Replace the entire contents of `.github/workflows/release-server-rust.yml` with:

```yaml
name: Release server-rust binaries

# Tag the commit to release, e.g.:
#   git tag server-rust-v0.1.0 && git push origin server-rust-v0.1.0
# Publishes three channels from one tag:
#   1. Prebuilt binary tarballs (+ SHA-256) attached to a GitHub Release.
#   2. The `durable-streams` crate to crates.io via Trusted Publishing (OIDC).
#   3. The @durable-streams/server-rust npm packages via Trusted Publishing (OIDC).
# No long-lived registry tokens are stored — both registries authenticate via the
# workflow's OIDC identity (see the bootstrap runbook for one-time setup).
on:
  push:
    tags:
      - "server-rust-v*"

permissions:
  contents: write
  id-token: write

jobs:
  assert-version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - name: Tag version matches Cargo.toml
        run: |
          tag="${GITHUB_REF_NAME#server-rust-v}"
          crate="$(sed -n 's/^version = "\(.*\)"/\1/p' packages/server-rust/Cargo.toml | head -1)"
          echo "tag=$tag cargo=$crate"
          if [ "$tag" != "$crate" ]; then
            echo "::error::tag version ($tag) != Cargo.toml version ($crate)"
            exit 1
          fi

  create-release:
    needs: assert-version
    runs-on: ubuntu-latest
    steps:
      - name: Create the GitHub Release (idempotent)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1 || \
            gh release create "$GITHUB_REF_NAME" \
              --title "$GITHUB_REF_NAME" \
              --generate-notes \
              --verify-tag

  build:
    needs: [assert-version, create-release]
    name: ${{ matrix.target }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: x86_64-unknown-linux-gnu
            os: ubuntu-latest
          - target: aarch64-unknown-linux-gnu
            os: ubuntu-24.04-arm
          - target: x86_64-apple-darwin
            os: macos-13
          - target: aarch64-apple-darwin
            os: macos-latest
    steps:
      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

      - name: Add Rust target
        run: rustup target add ${{ matrix.target }}

      - name: Build
        run: |
          cargo build --release --locked \
            --manifest-path packages/server-rust/Cargo.toml \
            --target ${{ matrix.target }}

      - name: Smoke test
        shell: bash
        run: |
          bin="packages/server-rust/target/${{ matrix.target }}/release/durable-streams-server"
          "$bin" --port 4599 --data-dir "$RUNNER_TEMP/smoke" &
          pid=$!
          ok=
          for _ in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:4599/health | grep -q ok; then ok=1; break; fi
            sleep 0.3
          done
          kill "$pid" 2>/dev/null || true
          test -n "$ok" || { echo "server did not answer /health"; exit 1; }

      - name: Package and checksum
        run: |
          version="${GITHUB_REF_NAME#server-rust-}"
          archive="durable-streams-server-${version}-${{ matrix.target }}.tar.gz"
          bindir="packages/server-rust/target/${{ matrix.target }}/release"
          tar -czf "$RUNNER_TEMP/$archive" -C "$bindir" durable-streams-server
          shasum -a 256 "$RUNNER_TEMP/$archive" | sed "s|$RUNNER_TEMP/||" \
            > "$RUNNER_TEMP/$archive.sha256"

      - name: Upload to the release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh release upload "$GITHUB_REF_NAME" \
            "$RUNNER_TEMP"/*.tar.gz "$RUNNER_TEMP"/*.tar.gz.sha256 \
            --clobber

      # Hand the raw binary to the npm-publish job (keyed by rust target).
      - name: Upload binary artifact for npm
        uses: actions/upload-artifact@65c4c4a1ddee5b72f698fdd19549f0f0fb45cf08 # v4
        with:
          name: bin-${{ matrix.target }}
          path: packages/server-rust/target/${{ matrix.target }}/release/durable-streams-server
          if-no-files-found: error

  cargo-publish:
    needs: assert-version
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - name: Authenticate to crates.io (Trusted Publishing, OIDC)
        uses: rust-lang/crates-io-auth-action@v1
        id: auth
      - name: cargo publish
        env:
          CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}
        run: cargo publish --locked --manifest-path packages/server-rust/Cargo.toml

  npm-publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"
      - name: Update npm for OIDC trusted publishing (>= 11.5.1)
        run: npm install -g npm@latest
      - name: Download built binaries
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
        with:
          path: ${{ runner.temp }}/bins
      - name: Arrange binaries by rust target
        run: |
          # download-artifact unpacks each as <path>/bin-<target>/durable-streams-server
          mkdir -p "$RUNNER_TEMP/arranged"
          for d in "$RUNNER_TEMP"/bins/bin-*; do
            target="$(basename "$d" | sed 's/^bin-//')"
            mkdir -p "$RUNNER_TEMP/arranged/$target"
            cp "$d/durable-streams-server" "$RUNNER_TEMP/arranged/$target/"
          done
      - name: Assemble npm packages
        run: |
          version="${GITHUB_REF_NAME#server-rust-v}"
          node packages/server-rust/npm/assemble.mjs \
            --version "$version" \
            --bins "$RUNNER_TEMP/arranged" \
            --out "$RUNNER_TEMP/npm-dist"
      - name: Publish platform packages, then main (OIDC)
        run: |
          set -e
          for d in "$RUNNER_TEMP"/npm-dist/*/; do
            [ "$(basename "$d")" = "main" ] && continue
            echo "publishing $d"
            npm publish "$d" --access public --provenance
          done
          echo "publishing main"
          npm publish "$RUNNER_TEMP/npm-dist/main" --access public --provenance
```

- [ ] **Step 2: Validate the workflow YAML**

Run (uses Docker; if unavailable, skip and rely on the dry-run tag):
```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/release-server-rust.yml
```
Expected: no errors. If Docker/actionlint is unavailable, instead confirm it parses:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release-server-rust.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-server-rust.yml
git commit -m "ci(server-rust): one tag publishes binaries + crate + npm via OIDC"
```

---

## Task 5: Install docs + bootstrap runbook

**Files:**
- Modify: `packages/server-rust/README.md` (add an "Install" section near the top)
- Create: `docs/superpowers/runbooks/server-rust-release-bootstrap.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add an Install section to the server README**

In `packages/server-rust/README.md`, immediately after the intro paragraph and before `## Quickstart`, insert:

```markdown
## Install

Three ways to get the server (Linux/macOS, x64/arm64):

```bash
# 1. cargo (builds the binary `durable-streams-server`)
cargo install durable-streams

# 2. npm (downloads a prebuilt binary for your platform)
npm install -g @durable-streams/server-rust

# 3. prebuilt tarball — download from the GitHub Releases page
#    (tag server-rust-vX.Y.Z), verify the .sha256, extract durable-streams-server
```

All three install the same `durable-streams-server` command.
```

- [ ] **Step 2: Verify the README renders without broken fences**

Run: `node -e "const s=require('fs').readFileSync('packages/server-rust/README.md','utf8'); const f=(s.match(/```/g)||[]).length; if(f%2)throw new Error('unbalanced code fences'); console.log('fences ok:',f)"`
Expected: `fences ok:` with an even number.

- [ ] **Step 3: Create the bootstrap runbook**

Create `docs/superpowers/runbooks/server-rust-release-bootstrap.md`:

```markdown
# Server-rust release bootstrap (one-time)

Trusted publishing on both registries requires the package/crate to exist before a
trusted publisher can be attached. So the FIRST release is done manually with
temporary tokens; every release after is driven by pushing a `server-rust-v*` tag
with no stored secrets.

## crates.io (crate `durable-streams`)

1. Sign in to crates.io with GitHub and verify your email.
2. Create a scoped API token; `cargo login <token>`.
3. From `packages/server-rust/`: `cargo publish --locked` (publishes the first version).
4. Delegate ownership to the org and keep yourself as a named owner:
   - Ensure crates.io has `read:org` for electric-sql (granted).
   - `cargo owner --add github:electric-sql:core`
   - (You remain a named owner — team owners cannot manage owners or trusted publishers.)
5. On the crate's crates.io **Settings → Trusted Publishing**, add:
   - Repository: `durable-streams/durable-streams`
   - Workflow: `release-server-rust.yml`
   - Environment: (leave blank)
   - Optionally enable "require trusted publishing".
6. Revoke the temporary API token.

## npm (5 packages)

1. With a granular automation token that can publish to the `@durable-streams` scope,
   publish each package once so it exists on the registry. Easiest: run the assemble
   step locally against the 4 built binaries, then `npm publish <dir> --access public`
   for each of the 4 platform dirs and `main`.
2. On npmjs.com, for EACH of the 5 packages, configure **Trusted Publisher**:
   - GitHub repository: `durable-streams/durable-streams`
   - Workflow filename: `release-server-rust.yml`
3. Revoke the automation token.

## After bootstrap

`git tag server-rust-v<X.Y.Z> && git push origin server-rust-v<X.Y.Z>` publishes all
three channels with no secrets. The tag version must equal `Cargo.toml`'s `version`
(the `assert-version` job enforces this).
```

- [ ] **Step 4: Commit**

```bash
git add packages/server-rust/README.md docs/superpowers/runbooks/server-rust-release-bootstrap.md
git commit -m "docs(server-rust): install instructions + release bootstrap runbook"
```

---

## Self-review notes

- **Spec coverage:** crate rename + `[[bin]]` (Task 1); npm multi-package optionalDeps + launcher + 4 platforms + assembler (Tasks 2-3); one-tag workflow with assert-version, binaries, cargo OIDC, npm OIDC (Task 4); bootstrap incl. `electric-sql:core` ownership + trusted-publisher repo + install docs (Task 5). The "light polish" `install.sh` is explicitly deferred in the spec and intentionally omitted.
- **No tokens in the committed workflow:** confirmed — only `secrets.GITHUB_TOKEN` (for the Release, first-party) and OIDC; no `CARGO_REGISTRY_TOKEN`/`NPM_TOKEN` secrets.
- **Type/name consistency:** binary `durable-streams-server`, crate `durable-streams`, main pkg `@durable-streams/server-rust`, `assemble({version,binsDir,outDir})`, artifact name `bin-<target>`, arranged path `<dir>/<rustTarget>/durable-streams-server` — consistent across Tasks 1-4.
- **Pinned action SHAs:** reused the repo's existing pins for checkout/setup-node from `release.yml`/`release-server-rust.yml`. `upload-artifact`/`download-artifact`/`crates-io-auth-action` SHAs in the plan must be re-verified against the latest v4/v1 release at implementation time (flagged for the implementer).
```
