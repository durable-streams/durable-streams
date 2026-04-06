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

1. [ ] CI strategy for live-agent tests
   - Decide which live suites run in CI vs local-only
   - Define required env, secrets, and machine assumptions for Claude and Codex
   - Keep `test:live:smoke` cheap enough to run regularly

2. [ ] CLI / API parity
   - Surface advanced Codex options in the CLI: approval policy, sandbox mode, experimental features, developer instructions, and env
   - Decide whether Claude-specific resume/path-rewrite controls should remain library-only or become explicit CLI flags

3. [ ] Persistable bridge debug mode
   - Optional on-stream debug envelopes for postmortems and replayable bridge telemetry
   - Keep the default path clean and protocol-stable

4. [ ] Recorded protocol fixture capture
   - Capture representative Claude and Codex raw histories as regression fixtures
   - Use them to harden normalizers and reduce reliance on live repro for protocol drift

5. [ ] Public docs / examples
   - Add a first-class user-facing docs page for `@durable-streams/coding-agents`
   - Include examples for browser clients, shared sessions, approvals, and resume

6. [ ] API polish
   - Review exported types and entrypoints for a publishable first release
   - Remove or clearly mark test-only/debug-only surfaces

7. [ ] Operational guidance
   - Document runtime prerequisites, expected agent versions, and known platform assumptions
   - Document when Claude seeded-workspace fallback is expected during cross-cwd resume
