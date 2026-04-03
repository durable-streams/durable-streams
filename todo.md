# Todo

1. [x] Real approval round-trips for both agents
   - Live allow-path coverage is in place for Claude and Codex

2. [x] Real interrupt behavior during an active turn
   - Live interrupt-path coverage is in place for Claude and Codex
   - Includes synthesized cancellation ordering checks when approval requests are pending
   - Includes queued prompt continuation checks after interruption

3. [x] Real deny/cancel approval variants for both agents
   - Live deny/cancel coverage is in place for Claude and Codex
   - Scenarios assert the bridge forwards exactly one response and side effects are blocked

4. [x] Real resume after bridge restart
   - Live restart/resume coverage is in place for Claude and Codex
   - Scenarios assert resumed bridge lifecycle events and successful post-resume turns

5. [x] Real prompt replay after restart before turn completion
   - Live mid-turn prompt replay coverage is in place for Claude and Codex
   - Scenarios verify a durably written in-flight prompt still produces the expected turn output after restart

6. [x] Multi-client duplicate response races against a live agent
   - Live two-client approval race coverage is in place for Claude and Codex
   - Scenarios assert `first_response_wins` and verify the winning response determines the observed outcome

7. [x] Multiple queued prompts against live agents
   - Live queued-prompt coverage is in place for Claude and Codex
   - Scenarios assert prompt B is not forwarded until prompt A completes

8. [ ] Codex app-server approval variants beyond command execution
   - Live file-change approval coverage is in place
   - Explicit Codex sandbox / approval-policy plumbing is in place
   - Permission grant requests are not yet reproducible under the current harness
   - `item/tool/requestUserInput` is not yet reproducible under the current harness

9. [x] Real normalization coverage from recorded histories
   - Live Claude and Codex prompt histories now assert stable client-facing event projections
   - Codex normalizer now suppresses common transport noise and no longer misclassifies initialize responses as turn completion

10. [x] Bridge crash / agent exit mid-turn

- Scripted bridge coverage now forces agent exit during a turn
- Scenarios assert lifecycle events, teardown, and prompt replay after resume

11. [ ] Path rewriting during resume across cwd changes

- Claude path-rewrite unit coverage is in place for resume transcript generation
- Live cross-cwd resume behavior is not yet validated end to end
