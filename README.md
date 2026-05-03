# pi-per-commit-spend

A [pi](https://github.com/badlogic/pi) extension that tracks AI spend per git commit across sessions.

Every time you commit in a repo, the extension records the total AI cost accumulated since the previous commit. Spend from multiple sessions is merged — if you work across three sessions before committing, all three sessions' costs roll into that commit's entry.

## Works with subscription providers

When using subscription services (GitHub Copilot, Claude Max, etc.) the API returns `cost = 0`. This extension automatically:

1. Fetches pricing data from [models.dev](https://models.dev) (4,000+ models)
2. Looks up the current model's real pricing across all providers
3. Calculates cost from token counts when the API reports zero

Calculated costs are tagged with `(calc)` in the `/spend` view.

### How subscription cost calculation works

Subscription providers (like GitHub Copilot) don't expose per-request pricing — the API reports `cost.total = 0` because you pay a flat monthly fee. This extension fills that gap:

1. **On session start**, it fetches [models.dev/api.json](https://models.dev/api.json) — a community-maintained database with pricing for 4,000+ models across 80+ providers
2. **On `model_select`**, it tracks which model is currently active (e.g. `claude-sonnet-4`, `gpt-5.1`)
3. **On each assistant message**, if `cost.total = 0`:
   - It searches models.dev for the model ID across **all providers** (not just the subscription one)
   - It skips providers that report zero cost (other subscriptions)
   - It picks the first provider with real per-token pricing
   - It calculates: `(input × input_price + output × output_price + cache_read × cache_read_price + cache_write × cache_write_price) / 1,000,000`
4. **Example**: You're using `claude-sonnet-4` via GitHub Copilot. The Copilot provider reports `cost: { input: 0, output: 0 }`. But the same model exists under the `anthropic` provider with `cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }` (per 1M tokens). The extension uses the Anthropic pricing to calculate your cost.

**Note**: The calculated cost is an **estimate** — it reflects what you *would* have paid per-token, not your actual subscription cost. This is useful for comparing productivity across projects and understanding relative spend per commit.

The pricing cache is refreshed every 24 hours. Use `/spend-refresh` to force an update.

## Install

```bash
pi install npm:@gtheys/pi-per-commit-spend
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
| `/spend-refresh` | Force-refresh models.dev pricing cache |

## How it works

1. **Fetches pricing** — On session start, loads [models.dev](https://models.dev) pricing data (cached 24h locally)
2. **Tracks model** — Listens to `model_select` to know which model is active
3. **Accumulates** — Every assistant message's usage is summed. If `cost.total > 0`, uses API cost. If `= 0`, calculates from tokens × models.dev pricing
4. **Records on commit** — When `git commit` succeeds, the accumulated spend is saved to disk
5. **Persists across sessions** — Uncommitted spend is saved as "pending" on shutdown, then reloaded into the accumulator on the next session

### Event flow

```
session_start → load pending entries, fetch models.dev pricing
       ↓
model_select → track current model ID
       ↓
message_end → accumulate cost (API cost or calculated from tokens)
       ↓
tool_result (git commit) → flush accumulator to DB, reset
       ↓
session_shutdown → save remaining accumulator as "pending" entry
```

### Cost calculation

```
For subscription providers (cost.total = 0):
  model = current model ID (e.g. "claude-sonnet-4")
  pricing = lookup across all models.dev providers
  cost = (input_tokens × input_price
        + output_tokens × output_price
        + cache_read_tokens × cache_read_price
        + cache_write_tokens × cache_write_price) / 1,000,000
```

## Storage

Data lives in `~/.pi/agent/data/`:

| File | Purpose |
|------|---------|
| `per-commit-spend.json` | Spend entries keyed by repo path |
| `per-commit-spend-models.json` | Cached models.dev pricing (refreshed every 24h) |

Entry format:

```json
{
  "commitHash": "abc1234",
  "commitMessage": "feat: add login page",
  "cost": 0.0423,
  "calculatedCost": true,
  "inputTokens": 15000,
  "outputTokens": 3000,
  "cacheReadTokens": 24000,
  "cacheWriteTokens": 5000,
  "timestamp": 1709600000000,
  "pending": false
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
