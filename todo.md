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

5. [ ] Real approval + resume together
   - Stop the bridge while an approval is pending or just after one client responds
   - Resume and verify reconciliation only includes the effective response

6. [ ] Multi-client duplicate response races against a live agent
   - Have two clients answer the same approval nearly simultaneously
   - Assert `first_response_wins` with a real agent process

7. [ ] Multiple queued prompts against live agents
   - Send prompt A and B quickly
   - Assert B is not forwarded until A completes

8. [ ] Codex app-server approval variants beyond command execution
   - File-change approval
   - Permission grant requests
   - `item/tool/requestUserInput` if it can be triggered reliably

9. [ ] Real normalization coverage from recorded histories
   - Capture real Claude and Codex histories
   - Assert normalizers produce stable client-facing events

10. [ ] Bridge crash / agent exit mid-turn

- Force child exit during a turn
- Assert lifecycle events, teardown, and restart behavior

11. [ ] Path rewriting during resume across cwd changes

- Resume from a different workspace path
- Verify reconstructed local state still behaves correctly
