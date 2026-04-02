# Todo

1. [x] Real approval round-trips for both agents
   - Live allow-path coverage is in place for Claude and Codex

2. [ ] Real interrupt behavior during an active turn
   - Start a long-running turn
   - Send `interrupt`
   - Assert synthesized cancellations happen before interrupt when needed
   - Assert the turn ends cleanly and queued prompts continue

3. [ ] Real deny/cancel approval variants for both agents
   - Trigger a real tool approval
   - Send explicit deny and cancel responses
   - Assert the bridge forwards exactly one effective response and the agent stops or recovers correctly

4. [ ] Real resume after bridge restart
   - Start a session, produce output, kill the bridge, resume in a new process
   - Verify resumed behavior matches uninterrupted execution closely enough for the scenario

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
