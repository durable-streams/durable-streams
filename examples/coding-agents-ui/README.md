# Coding Agents UI Example

Prototype frontend for `@durable-streams/coding-agents`.

It starts and resumes real Claude Code or Codex bridge sessions on the app
server, proxies the durable stream over same-origin routes for the browser, and
renders both normalized and raw session history.

## Run it

```bash
pnpm --filter @durable-streams/example-coding-agents-ui dev
```

Defaults:

- app: `http://localhost:3004`
- durable streams dev server: `http://localhost:4437`
- default agent cwd: repo root

## Requirements

- `claude` installed and authenticated for Claude sessions
- `codex` installed and authenticated for Codex sessions

## Why this example exists

This is deliberately a product-prototype app, not just a demo shell. It should
surface missing package features around:

- browser client ergonomics
- approval UX
- resume and bridge lifecycle control
- raw versus normalized event visibility
