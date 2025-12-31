# Spawning Sub-Instances

When you identify multiple independent tasks that could be parallelized, use the `spawn-instance` CLI to create sub-instances.

## When to Spawn

Consider spawning sub-instances when you have:

- **Multiple independent bugs** that don't share code paths
- **Parallel feature implementations** that touch different modules
- **Test fixes across different modules** that don't interfere
- **Refactoring tasks** that affect separate, unrelated files
- **Documentation updates** for different sections

## How to Spawn

Basic usage:
```bash
spawn-instance --task "Brief task description" --context "Detailed context"
```

With extensive context using heredoc:
```bash
spawn-instance --task "Fix authentication bug" <<EOF
The authentication middleware is failing for users with expired JWT tokens.

Error trace:
[paste error here]

Relevant files:
- src/auth/middleware.ts (line 45)
- src/auth/jwt.ts

Expected behavior: Return 401 with refresh token hint
EOF
```

## Important Notes

1. **Independent branches**: Each sub-instance works on its own auto-generated branch (e.g., `claude-code/a1b2c3d4`)

2. **Fire-and-forget**: Sub-instances are independent - you won't receive status callbacks or see their output

3. **No communication**: There's no way to communicate back to sub-instances after spawning

4. **Resource usage**: Each instance consumes API credits and compute resources - use sparingly

5. **Best for parallel work**: Only spawn when tasks are truly independent and parallelization provides value

## Example Scenarios

### Good Use Case: Multiple Independent Bug Fixes
```bash
spawn-instance --task "Fix login redirect bug" --context "Users not redirected after OAuth login"
spawn-instance --task "Fix pagination in search" --context "Search results show wrong page count"
spawn-instance --task "Fix dark mode toggle" --context "Toggle state not persisted"
```

### Bad Use Case: Sequential Dependencies
Don't spawn these as sub-instances - they depend on each other:
- "Set up database schema" (needed first)
- "Create API endpoints" (needs schema)
- "Build frontend forms" (needs API)

## After Spawning

After spawning sub-instances:
1. Each will create a PR from their branch
2. You can continue working on your current task
3. Review and merge PRs when sub-instances complete
4. Resolve any merge conflicts between branches
