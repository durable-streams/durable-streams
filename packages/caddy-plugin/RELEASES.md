# Release Process

This document outlines the release process for the Caddy Durable Streams plugin.

## Overview

Releases are automated using GoReleaser and GitHub Actions. When you push a tag with the format `caddy-v*`, the CI system automatically:

1. Builds binaries for all platforms (Linux, macOS, Windows; amd64 & arm64)
2. Creates a GitHub release with release notes
3. Uploads all binaries as release assets
4. Generates checksums for verification

## Pre-Release Checklist

Before creating a release, ensure:

- [ ] All tests pass locally (`go test ./...`)
- [ ] Conformance tests pass (`pnpm test:run`)
- [ ] CI is passing on the branch
- [ ] Code is merged to `main` branch
- [ ] You're on the latest `main` branch locally
- [ ] Working directory is clean (`git status`)
- [ ] README.md is up to date with any new features
- [ ] Version number follows semantic versioning

## Creating a Release

### 1. Determine Version Number

Follow [Semantic Versioning](https://semver.org/):

- **Major** (v1.0.0 → v2.0.0): Breaking API changes
- **Minor** (v1.0.0 → v1.1.0): New features, backward compatible
- **Patch** (v1.0.0 → v1.0.1): Bug fixes, backward compatible

### 2. Create and Push the Tag

```bash
# Ensure you're on main and up to date
git checkout main
git pull origin main

# Create the tag (replace with your version)
VERSION="0.1.0"
git tag caddy-v${VERSION}

# Push the tag to trigger the release
git push origin caddy-v${VERSION}
```

### 3. Monitor the Release

1. Go to [GitHub Actions](https://github.com/durable-streams/durable-streams/actions)
2. Find the "Release Caddy Binary" workflow that was triggered
3. Monitor the build progress (~5-10 minutes)
4. If it fails, you can delete the tag and try again:
   ```bash
   git tag -d caddy-v${VERSION}
   git push origin :refs/tags/caddy-v${VERSION}
   ```

### 4. Verify the Release

Once the workflow completes:

1. Go to [GitHub Releases](https://github.com/durable-streams/durable-streams/releases)
2. Find the newly created release "Caddy Server v${VERSION}"
3. Verify all binaries are present:
   - `durable-streams-server_${VERSION}_darwin_amd64.tar.gz`
   - `durable-streams-server_${VERSION}_darwin_arm64.tar.gz`
   - `durable-streams-server_${VERSION}_linux_amd64.tar.gz`
   - `durable-streams-server_${VERSION}_linux_arm64.tar.gz`
   - `durable-streams-server_${VERSION}_windows_amd64.zip`
   - `checksums.txt`
4. Review the auto-generated changelog
5. Edit the release notes if needed to add highlights or breaking changes

### 5. Test the Install Script

Test the one-line installer fetches the new version:

```bash
# Test latest version install
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh

# Verify version
durable-streams-server version

# Test specific version install
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh -s v${VERSION}
```

## Release Artifacts

Each release includes:

### Binaries

Platform-specific archives containing:

- `durable-streams-server` executable
- `LICENSE`
- `README.md`
- `Caddyfile` (example configuration)

### Platforms

- **macOS**: Apple Silicon (arm64) and Intel (amd64)
- **Linux**: x86_64 (amd64) and ARM64
- **Windows**: x86_64 (amd64) only

### Checksums

The `checksums.txt` file contains SHA256 hashes for all binaries, allowing users to verify downloads:

```bash
sha256sum -c checksums.txt
```

## Version Number Scheme

Tags follow the format: `caddy-v{MAJOR}.{MINOR}.{PATCH}`

Examples:

- `caddy-v0.1.0` - Initial release
- `caddy-v0.1.1` - Bug fix
- `caddy-v0.2.0` - New feature
- `caddy-v1.0.0` - Stable API, production ready

## Troubleshooting

### Release Build Failed

**Problem**: GoReleaser workflow failed

**Solutions**:

1. Check the GitHub Actions logs for errors
2. Test the build locally:
   ```bash
   cd packages/caddy-plugin
   go mod tidy
   go test ./...
   go build -o durable-streams-server ./cmd/caddy
   ```
3. If tests fail, fix the issues and create a new patch version
4. If build config is wrong, update `.goreleaser.yml` and retry

### Tag Already Exists

**Problem**: You need to recreate a tag

**Solution**:

```bash
# Delete local tag
git tag -d caddy-v${VERSION}

# Delete remote tag
git push origin :refs/tags/caddy-v${VERSION}

# Recreate and push
git tag caddy-v${VERSION}
git push origin caddy-v${VERSION}
```

### Install Script Not Finding Release

**Problem**: Install script fails with "Could not determine latest version"

**Possible causes**:

1. Release hasn't been published yet (wait a few minutes)
2. Tag doesn't follow the `caddy-v*` format
3. GitHub API rate limit (wait an hour or authenticate)

### Binary Won't Run

**Problem**: Downloaded binary fails to execute

**Solutions**:

1. Verify the checksum matches
2. Check file permissions: `chmod +x durable-streams-server`
3. Ensure you downloaded the correct platform/architecture
4. On macOS, if blocked: `xattr -d com.apple.quarantine durable-streams-server`

## Configuration Files

### .goreleaser.yml

Defines the build configuration:

- Build settings (CGO disabled, ldflags)
- Target platforms and architectures
- Archive format per platform
- Files to include in archives
- Changelog generation rules

### .github/workflows/release-caddy.yml

GitHub Actions workflow that:

- Triggers on `caddy-v*` tags
- Sets up Go 1.25
- Runs GoReleaser
- Uploads artifacts

## Best Practices

1. **Never force-push tags** - Tags should be immutable
2. **Test before tagging** - Run full test suite locally first
3. **Tag from main** - Only create release tags from the main branch
4. **Document breaking changes** - Clearly note any breaking changes in release notes
5. **Announce releases** - Update any relevant documentation or announcements
6. **Keep cadence regular** - Regular releases build user confidence

## Release Checklist Template

Copy this checklist for each release:

```markdown
## Release v0.X.Y Checklist

- [ ] All tests passing locally
- [ ] CI green on main
- [ ] On latest main branch
- [ ] Working directory clean
- [ ] README updated
- [ ] Create tag: `git tag caddy-v0.X.Y`
- [ ] Push tag: `git push origin caddy-v0.X.Y`
- [ ] Monitor GitHub Actions
- [ ] Verify all binaries uploaded
- [ ] Test install script
- [ ] Edit release notes if needed
- [ ] Announce release (if applicable)
```

## Future Improvements

Ideas for enhancing the release process:

- [ ] Automated changelog generation from conventional commits
- [ ] Release candidates for major versions (e.g., `caddy-v1.0.0-rc.1`)
- [ ] Automated testing of install script in CI
- [ ] Docker images published alongside binaries
- [ ] Homebrew tap for macOS installation
- [ ] APT/RPM packages for Linux distributions
