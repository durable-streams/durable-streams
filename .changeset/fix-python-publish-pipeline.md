---
"@durable-streams/client-py": patch
---

fix(release): wire up Python package publishing to PyPI

The repo had `scripts/sync-python-versions.mjs` and
`scripts/publish-python.mjs` checked in but neither was invoked by the
`changeset:version` / `changeset:publish` npm scripts, so PyPI never
received any release after `0.1.0` despite Changesets bumping the bridge
`package.json` and writing CHANGELOG entries up to `0.1.3` (which
includes the Kafka-style idempotent producer from #140).

This wires both helpers into the release flow:

- `changeset:version` now runs `sync-python-versions.mjs` so a Changesets
  Version Packages PR also bumps `pyproject.toml`.
- `changeset:publish` now runs `publish-python.mjs` after `changeset
  publish`, so `uv build && uv publish` runs whenever the npm publish
  step does.
- `publish-python.mjs` now passes `--check-url https://pypi.org/simple/`
  so the script is idempotent — TS-only changesets that don't bump the
  Python version will simply skip the upload instead of erroring.
- `sync-python-versions.mjs` now edits `pyproject.toml` directly instead
  of shelling out to `uv version <X>` (the setter form requires uv
  ≥ 0.7), making it work across uv releases.
- `release.yml` now installs `uv` + Python and passes
  `UV_PUBLISH_TOKEN` from the `PYPI_TOKEN` secret.
- `pyproject.toml` is bumped from `0.1.0` to `0.1.3` to catch up with
  the bridge `package.json`, so the next release publishes the
  already-changelogged versions to PyPI.
