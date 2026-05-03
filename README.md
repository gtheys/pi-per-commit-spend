# pi-per-commit-spend

A [pi](https://github.com/badlogic/pi) extension that tracks AI spend per git commit across sessions.

Every time you commit in a repo, the extension records the total AI cost accumulated since the previous commit. Spend from multiple sessions is merged — if you work across three sessions before committing, all three sessions' costs roll into that commit's entry.

## Install

```bash
pi install npm:pi-per-commit-spend
```

Or install from git:

```bash
pi install git:github.com/gtheys/pi-per-commit-spend
```

## Commands

| Command | Description |
|---------|-------------|
| `/spend` | Interactive spend breakdown per commit (Space to expand, Esc/q to close) |
| `/spend-reset` | Clear all recorded spend data for the current repo |

## How it works

1. **Accumulates** — Every assistant message's `usage.cost.total` is summed in memory
2. **Records on commit** — When `git commit` succeeds, the accumulated spend is saved to disk
3. **Persists across sessions** — Uncommitted spend is saved as "pending" on shutdown, then reloaded into the accumulator on the next session so it merges into the next commit
4. **Survives restarts** — Pending entries from previous sessions automatically roll forward

### Event flow

```
session_start → load pending entries from DB into accumulator
       ↓
message_end → accumulate cost from usage
       ↓
tool_result (git commit) → flush accumulator to DB, reset
       ↓
session_shutdown → save remaining accumulator as "pending" entry
```

## Storage

Data lives in `~/.pi/agent/data/per-commit-spend.json`, keyed by repo path:

```json
{
  "/home/user/my-project": {
    "entries": [
      {
        "commitHash": "abc1234",
        "commitMessage": "feat: add login page",
        "cost": 0.0423,
        "inputTokens": 15000,
        "outputTokens": 3000,
        "cacheReadTokens": 24000,
        "cacheWriteTokens": 5000,
        "timestamp": 1709600000000,
        "pending": false
      }
    ]
  }
}
```

## Development

```bash
npm install
npm run build      # compiles src/ → extensions/
npm pack --dry-run # preview tarball contents
```

## License

MIT
