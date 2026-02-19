# Create Tasks from RFC

Read the RFC specification and generate a task list.

## Instructions

1. Read the RFC content provided below
2. Break down the implementation into discrete, testable tasks
3. Order tasks by dependency (setup first, then features, then tests)
4. Each task should be completable in one commit
5. Output tasks.json to /var/local/wisp/session/tasks.json

## Task Guidelines

- Keep tasks focused and atomic
- Include setup tasks (dependencies, configuration)
- Include test tasks where appropriate
- Mark all tasks with "passes": false initially

## Output Format

Write a valid JSON array to /var/local/wisp/session/tasks.json with this structure:

```json
[
  {
    "category": "setup",
    "description": "Task description",
    "steps": ["Step 1", "Step 2"],
    "passes": false
  }
]
```

## RFC Content

Read the RFC from the path specified in your session configuration.
