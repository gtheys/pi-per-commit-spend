# 📊 Ever wonder how much AI actually costs per commit?

I just shipped **pi-per-commit-spend** — a tiny extension for [pi](https://github.com/badlogic/pi) that answers one question:

> *How much did the AI spend to produce this commit?*

It tracks AI cost per `git commit`, automatically, across sessions. Every time you commit, it records the total tokens and dollars burned since the last one.

## The subscription problem

Here's the catch: if you use **GitHub Copilot, Claude Max, or any flat-rate plan**, the API returns `cost = 0`. You're paying $39/month but have zero visibility into per-request spend.

This extension fixes that by pulling real per-token pricing from [models.dev](https://models.dev) (4,000+ models) and calculating cost from your actual token usage. Same model running through Copilot? It finds the Anthropic/OpenAI pricing and does the math.

```
$ /spend

─── AI Spend Per Commit ─────────────────────────

  e3d1c77  $0.0569 (calc)  feat: add login page
  7a2b1ff  $0.0501          fix: validate email input
  0c8f5d2  $0.0567          refactor: extract helpers

  Total: $0.1637 (3 entries)
  Pricing: models.dev (4448 models)
```

## Install in one command

```bash
pi install npm:@gtheys/pi-per-commit-spend
```

Works with any provider — API-reported cost, calculated cost, or a mix.

🔗 **[gtheys/pi-per-commit-spend](https://github.com/gtheys/pi-per-commit-spend)**
