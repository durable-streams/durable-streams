# Update Tasks from RFC Changes

The RFC has been updated. Reconcile the task list with the changes.

## Instructions

1. Read the RFC diff provided below
2. Read the current tasks.json from /var/local/wisp/session/tasks.json
3. Identify which tasks need to be:
   - Modified (requirements changed)
   - Added (new features)
   - Removed (features cut)
   - Marked incomplete (needs rework)
4. Output updated tasks.json

## Guidelines

- Preserve completed tasks where possible
- Mark tasks as passes: false if they need rework
- Add new tasks for new requirements
- Remove tasks for cut features
- Maintain dependency ordering

## Output

Write updated tasks.json to /var/local/wisp/session/tasks.json.
