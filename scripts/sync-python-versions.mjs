/**
 * Sync Python package versions from bridge package.json files to pyproject.toml.
 * This script is called by Changesets during the version command.
 *
 * Edits pyproject.toml directly rather than calling `uv version <X>` so it
 * works regardless of which uv release is installed (the setter form was
 * added in uv 0.7).
 */

import { readFile, writeFile } from "node:fs/promises"

const PY_PKGS = [
  {
    dir: `packages/client-py`,
    bridge: `packages/client-py/package.json`,
    pyproject: `packages/client-py/pyproject.toml`,
    lockfile: `packages/client-py/uv.lock`,
    // PEP 503 normalized name as recorded in uv.lock
    distName: `durable-streams`,
  },
]

/**
 * Convert semver prereleases to PEP 440 format
 * e.g., 1.2.3-alpha.1 -> 1.2.3a1
 */
function toPep440(version) {
  return version
    .replace(/-alpha\.(\d+)$/, `a$1`)
    .replace(/-beta\.(\d+)$/, `b$1`)
    .replace(/-rc\.(\d+)$/, `rc$1`)
    .replace(/-dev\.(\d+)$/, `.dev$1`)
}

for (const pkg of PY_PKGS) {
  const { version } = JSON.parse(await readFile(pkg.bridge, `utf8`))
  const pep440Version = toPep440(version)

  // Match the first top-level `version = "..."` line in pyproject.toml.
  const pyprojectRe = /^version\s*=\s*"[^"]*"\s*$/m
  const pyproject = await readFile(pkg.pyproject, `utf8`)
  if (!pyprojectRe.test(pyproject)) {
    throw new Error(
      `Failed to find version field in ${pkg.pyproject} — sync aborted`
    )
  }
  await writeFile(
    pkg.pyproject,
    pyproject.replace(pyprojectRe, `version = "${pep440Version}"`)
  )
  console.log(`Synced ${pkg.pyproject} to version ${pep440Version}`)

  // Keep uv.lock in sync so `uv sync --frozen` keeps working without
  // requiring a separate `uv lock` step in CI.
  const lockEntryRe = new RegExp(
    String.raw`(\[\[package\]\]\s*\nname\s*=\s*"${pkg.distName}"\s*\nversion\s*=\s*")[^"]*(")`,
    `m`
  )
  const lockfile = await readFile(pkg.lockfile, `utf8`)
  if (!lockEntryRe.test(lockfile)) {
    throw new Error(
      `Failed to find ${pkg.distName} entry in ${pkg.lockfile} — sync aborted`
    )
  }
  await writeFile(
    pkg.lockfile,
    lockfile.replace(lockEntryRe, `$1${pep440Version}$2`)
  )
  console.log(`Synced ${pkg.lockfile} to version ${pep440Version}`)
}

console.log(`Python versions synced successfully`)
