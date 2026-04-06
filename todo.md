# Todo

## Phase 1 Status

Phase 1 is complete.

Validated end to end:

- Claude and Codex prompt round trips
- approval allow / deny / cancel flows
- interrupts with synthesized cancellation ordering
- restart / resume
- prompt replay after restart before turn completion
- multi-client duplicate response races
- queued prompts
- Codex `file_change`, `permissions`, and `request_user_input`
- normalization stability
- bridge crash / agent exit mid-turn
- Claude cross-cwd resume via seeded-workspace fallback

## Phase 2 Backlog

1. [x] CI strategy for live-agent tests
   - Manual self-hosted smoke workflow added in `.github/workflows/coding-agents-live.yml`
   - Claude and Codex smoke jobs are split by runner label
   - Full live suites remain explicit/manual rather than default PR-gated CI

2. [x] CLI / API parity
   - The CLI now surfaces advanced Codex options: approval policy, sandbox mode, experimental features, developer instructions, and env
   - Claude-specific resume/path-rewrite controls remain library-only because they are adapter-internal recovery behavior rather than stable CLI concepts

3. [x] Persistable bridge debug mode
   - Optional on-stream debug envelopes now exist behind `debugStream: true`
   - The default path remains protocol-stable and does not append bridge debug events

4. [x] Recorded protocol fixture capture
   - Representative Claude and Codex raw histories are checked into `packages/coding-agents/test/fixtures`
   - Normalizer regression tests now run against ordered mixed-event histories, not just one-off hand-built events

5. [x] Public docs / examples
   - Added `docs/coding-agents.md` and linked it in the VitePress sidebar
   - Added user-facing examples for clients, shared approvals, resume, CLI usage, and debugging

6. [x] API polish
   - Added explicit advanced subpath exports for `./normalize` and `./protocol`
   - Clearly marked bridge debug hooks and persisted debug telemetry as advanced diagnostic surfaces

7. [x] Operational guidance
   - Documented runtime prerequisites, local checks, and live test tiers in the package README and docs page
   - Documented when Claude seeded-workspace fallback is expected during cross-cwd resume
