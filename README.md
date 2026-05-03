# pi-per-commit-spend

A [pi](https://github.com/badlogic/pi) extension that tracks AI spend per git commit.

Each time you commit in the current repo, the extension records the total AI cost accumulated
since the previous commit (or since the session started). Data persists across sessions in a
local JSON database.

## Install

Copy or symlink into your pi extensions directory:

```bash
# Global (all projects)
ln -s $(pwd)/per-commit-spend.ts ~/.pi/agent/extensions/per-commit-spend.ts

# Or project-local
mkdir -p .pi/extensions
ln -s $(pwd)/per-commit-spend.ts .pi/extensions/per-commit-spend.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/spend` | Show spend breakdown per commit for the current repo |
| `/spend-reset` | Clear all recorded spend data for the current repo |

## How it works

1. Listens to `message_end` for assistant messages and accumulates `usage.cost.total`
2. Intercepts `git commit` calls via `tool_call` — after the commit succeeds, records the accumulated spend
3. On `session_shutdown`, records any uncommitted spend as a "pending" entry
4. Data is stored in `~/.pi/agent/data/per-commit-spend.json`

## Data format

```json
{
  "/path/to/repo": {
    "entries": [
      {
        "commitHash": "abc1234",
        "commitMessage": "feat: add login page",
        "cost": 0.0423,
        "inputTokens": 15000,
        "outputTokens": 3000,
        "timestamp": 1709600000000,
        "pending": false
      }
    ]
  }
}
```
