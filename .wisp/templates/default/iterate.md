# Iteration Instructions

Complete the next incomplete task in the task list.

## Steps

1. Read /var/local/wisp/session/tasks.json and find the first task where passes is false
2. Read /var/local/wisp/session/state.json for context on previous iteration
3. Check /var/local/wisp/session/response.json for human response (delete after reading)
4. Implement the task following its steps
5. Verify your work (tests, typecheck, build as appropriate)
6. Commit your changes with a descriptive message
7. Update /var/local/wisp/session/tasks.json to mark the task as passes: true
8. Write /var/local/wisp/session/state.json with your status

## State Updates

Always write state.json after completing work:

```json
{
  "status": "CONTINUE",
  "summary": "Implemented feature X with tests",
  "verification": {
    "method": "tests",
    "passed": true,
    "details": "12 tests passed"
  }
}
```

## When Blocked

If you cannot proceed:

- Need human input: status "NEEDS_INPUT" with "question"
- Cannot continue: status "BLOCKED" with "error"

## RFC Divergence

If your implementation differs from the RFC (e.g., better approach discovered),
append a note to /var/local/wisp/session/divergence.md explaining the deviation.

## Completion

When all tasks have passes: true, set status to "DONE".
