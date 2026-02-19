# Generate PR Title and Description

Generate a concise, informative pull request title and description based on the specification and completed tasks.

## Instructions

1. Read the spec from /var/local/wisp/session/spec.md
2. Read the completed tasks from /var/local/wisp/session/tasks.json
3. Generate a PR title and description that:
   - Explains the **purpose** and **value** of the changes (not just what was done)
   - Uses conventional commit format for the title (feat:, fix:, etc.)
   - Summarizes the key capabilities added
   - Is written for a human reviewer, not a task tracker

## Guidelines

**Title:**

- Use conventional commit prefix: `feat:` for features, `fix:` for bugs, `refactor:` for refactoring
- Focus on the user-facing outcome, not implementation details
- Keep under 72 characters
- Example: "feat: add remote web UI for monitoring wisp sessions"

**Description:**

- Start with a `## Summary` section with 1-3 sentences explaining the purpose and value
- Add a `### Key Changes` section with bullet points summarizing the main capabilities (grouped conceptually, not just listing every task)
- End with the full task list as a checklist (with `- [x]` for completed tasks) in a collapsed `<details>` block
- Only include the task list ONCE (in the details block)
- End with a wisp attribution line

## Output Format

Write a valid JSON object to /var/local/wisp/session/pr.json with this structure:

```json
{
  "title": "feat: concise description of the change",
  "body": "## Summary\n\nPurpose and value of this PR in 1-3 sentences.\n\n### Key Changes\n\n- Capability 1\n- Capability 2\n- Capability 3\n\n<details>\n<summary>Tasks completed (N/N)</summary>\n\n- [x] Task 1\n- [x] Task 2\n- [x] Task 3\n\n</details>\n\n---\n🤖 Generated with [wisp](https://github.com/thruflo/wisp)"
}
```

Read the spec and tasks, then generate the PR content.
