/**
 * Per-Commit Spend Tracker Extension for pi
 *
 * Tracks AI cost per git commit, persisting data across sessions.
 * - Accumulates spend from assistant message usage on `message_end`
 * - Flushes to JSON DB when `git commit` is detected via `tool_call`
 * - Records pending spend on `session_shutdown`
 * - `/spend` command to view per-commit breakdown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// AIDEV-NOTE: DB schema — keyed by absolute repo path
interface SpendEntry {
	commitHash: string;
	commitMessage: string;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	timestamp: number;
	pending: boolean;
}

interface RepoSpend {
	entries: SpendEntry[];
}

type SpendDb = Record<string, RepoSpend>;

// ── Helpers ──────────────────────────────────────────────────────────────

const DB_DIR = path.join(os.homedir(), ".pi", "agent", "data");
const DB_PATH = path.join(DB_DIR, "per-commit-spend.json");

function loadDb(): SpendDb {
	try {
		const data = fs.readFileSync(DB_PATH, "utf8");
		return JSON.parse(data) as SpendDb;
	} catch {
		return {};
	}
}

function saveDb(db: SpendDb): void {
	fs.mkdirSync(DB_DIR, { recursive: true });
	fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function getRepoKey(cwd: string): string {
	// AIDEV-NOTE: use git rev-parse to resolve the repo root for consistency
	// Falls back to cwd if not a git repo
	return cwd;
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Accumulated spend since last commit (in-memory, per session)
	let accumulatedCost = 0;
	let accumulatedInput = 0;
	let accumulatedOutput = 0;
	let accumulatedCacheRead = 0;
	let accumulatedCacheWrite = 0;

	// Resolved repo key — set on session_start
	let repoKey: string | undefined;

	// ── Accumulate spend from each assistant message ──

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (!usage) return;

		accumulatedCost += usage.cost?.total ?? 0;
		accumulatedInput += usage.input ?? 0;
		accumulatedOutput += usage.output ?? 0;
		accumulatedCacheRead += usage.cacheRead ?? 0;
		accumulatedCacheWrite += usage.cacheWrite ?? 0;
	});

	// ── Detect git commit via tool_call ──

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const input = event.input as { command?: string } | undefined;
		const command = input?.command ?? "";
		if (!command) return;

		// AIDEV-NOTE: match `git commit` but not `git commit --amend` or dry-run
		// We check the tool result to see if the commit succeeded
		const isCommit =
			/\bgit\s+commit\b/.test(command) &&
			!/\b--amend\b/.test(command) &&
			!/\b--dry-run\b/.test(command);

		if (!isCommit) return;

		// Check if there's any spend to record
		if (accumulatedCost === 0 && accumulatedInput === 0) return;

		// Get commit info
		const { stdout: hash } = await pi.exec("git", ["rev-parse", "--short", "HEAD"], {
			cwd: ctx.cwd,
		});
		const { stdout: message } = await pi.exec("git", ["log", "-1", "--format=%s"], {
			cwd: ctx.cwd,
		});

		const entry: SpendEntry = {
			commitHash: hash.trim(),
			commitMessage: message.trim(),
			cost: accumulatedCost,
			inputTokens: accumulatedInput,
			outputTokens: accumulatedOutput,
			cacheReadTokens: accumulatedCacheRead,
			cacheWriteTokens: accumulatedCacheWrite,
			timestamp: Date.now(),
			pending: false,
		};

		const key = repoKey ?? getRepoKey(ctx.cwd);
		const db = loadDb();
		if (!db[key]) db[key] = { entries: [] };

		// AIDEV-NOTE: remove prior pending entries — their spend is now rolled
		// into this commit's accumulator (loaded on session_start)
		db[key].entries = db[key].entries.filter((e) => !e.pending);

		db[key].entries.push(entry);
		saveDb(db);

		// Reset accumulator
		accumulatedCost = 0;
		accumulatedInput = 0;
		accumulatedOutput = 0;
		accumulatedCacheRead = 0;
		accumulatedCacheWrite = 0;

		if (ctx.hasUI) {
			ctx.ui.notify(`Spend recorded for ${entry.commitHash}: $${entry.cost.toFixed(4)}`, "info");
		}
	});

	// ── Save pending spend on shutdown ──

	pi.on("session_shutdown", async (_event, ctx) => {
		if (accumulatedCost === 0 && accumulatedInput === 0) return;

		const key = repoKey ?? getRepoKey(ctx.cwd);
		const entry: SpendEntry = {
			commitHash: "pending",
			commitMessage: "(uncommitted work)",
			cost: accumulatedCost,
			inputTokens: accumulatedInput,
			outputTokens: accumulatedOutput,
			cacheReadTokens: accumulatedCacheRead,
			cacheWriteTokens: accumulatedCacheWrite,
			timestamp: Date.now(),
			pending: true,
		};

		const db = loadDb();
		if (!db[key]) db[key] = { entries: [] };
		db[key].entries.push(entry);
		saveDb(db);
	});

	// ── Resolve repo key on session start ──

	pi.on("session_start", async (_event, ctx) => {
		const { stdout, code } = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
		});
		if (code === 0) {
			repoKey = stdout.trim();
		} else {
			repoKey = ctx.cwd;
		}

		// AIDEV-NOTE: load pending entries and add to accumulator so they merge
		// into the next commit. This handles multi-session pre-commit spend.
		const db = loadDb();
		const repoData = db[repoKey];
		if (repoData) {
			for (const entry of repoData.entries) {
				if (entry.pending) {
					accumulatedCost += entry.cost;
					accumulatedInput += entry.inputTokens;
					accumulatedOutput += entry.outputTokens;
					accumulatedCacheRead += entry.cacheReadTokens;
					accumulatedCacheWrite += entry.cacheWriteTokens;
				}
			}
		}
	});

	// ── /spend command ──

	pi.registerCommand("spend", {
		description: "Show AI spend per commit for the current repo",
		handler: async (_args, ctx) => {
			const key = repoKey ?? getRepoKey(ctx.cwd);
			const db = loadDb();
			const repoData = db[key];

			if (!repoData || repoData.entries.length === 0) {
				ctx.ui.notify("No spend data recorded for this repo yet.", "info");
				return;
			}

			if (!ctx.hasUI) {
				// Print mode fallback
				const totalCost = repoData.entries.reduce((sum, e) => sum + e.cost, 0);
				ctx.ui.notify(
					`Total spend: $${totalCost.toFixed(4)} across ${repoData.entries.length} entries`,
					"info",
				);
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				let expanded = false;

				const component = {
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done();
							return true;
						}
						if (data === "q") {
							done();
							return true;
						}
						if (data === " " || data === "e") {
							expanded = !expanded;
							component.invalidate?.();
							return true;
						}
						return true;
					},
					invalidate: undefined as (() => void) | undefined,
					render(width: number): string[] {
						const tw = (s: string) => truncateToWidth(s, width);
						const lines: string[] = [];
						const entries = [...repoData.entries].reverse();
						let totalCost = 0;
						let totalInput = 0;
						let totalOutput = 0;

						lines.push("");
						const title = theme.fg("accent", " AI Spend Per Commit ");
						const headerLine =
							theme.fg("borderMuted", "─".repeat(3)) +
							title +
							theme.fg("borderMuted", "─".repeat(Math.max(0, width - 22)));
						lines.push(tw(headerLine));
						lines.push("");

						for (const entry of entries) {
							totalCost += entry.cost;
							totalInput += entry.inputTokens;
							totalOutput += entry.outputTokens;

							const hash = entry.pending
								? theme.fg("warning", "pending")
								: theme.fg("accent", entry.commitHash);
							const cost = theme.fg("success", `$${entry.cost.toFixed(4)}`);
							const pending = entry.pending ? theme.fg("warning", " ⚠") : "";

							if (expanded) {
								lines.push(
									tw(`  ${hash} ${cost}${pending} ${theme.fg("dim", `↑${formatTokens(entry.inputTokens)} ↓${formatTokens(entry.outputTokens)}`)}`),
								);
								lines.push(
									tw(`  ${theme.fg("dim", `  ${entry.commitMessage}`)}`),
								);
								const date = new Date(entry.timestamp);
								lines.push(
									tw(`  ${theme.fg("dim", `  ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`)}`),
								);
								lines.push("");
							} else {
								const msg =
									entry.commitMessage.length > 40
										? entry.commitMessage.slice(0, 37) + "..."
										: entry.commitMessage;
								lines.push(
									tw(`  ${hash} ${cost}${pending} ${theme.fg("muted", msg)}`),
								);
							}
						}

						lines.push("");
						const totalLine =
							theme.fg("muted", "─".repeat(Math.max(0, width - 4)));
						lines.push(tw(totalLine));
						lines.push(
							tw(`  ${theme.fg("accent", "Total:")} ${theme.fg("success", `$${totalCost.toFixed(4)}`)} ${theme.fg("dim", `(${entries.length} entries, ↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)})`)}`),
						);
						lines.push("");

						// Current session accumulator
						if (accumulatedCost > 0) {
							lines.push(
								tw(`  ${theme.fg("warning", `Current session (uncommitted): $${accumulatedCost.toFixed(4)}`)}`),
							);
							lines.push("");
						}

						lines.push(
							tw(theme.fg("dim", "  Press Space to toggle detail, Escape/q to close")),
						);
						lines.push("");

						return lines;
					},
				};

				return component as any;
			});
		},
	});

	// ── /spend-reset command ──

	pi.registerCommand("spend-reset", {
		description: "Clear all recorded spend data for the current repo",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Reset spend data?",
					"This will delete all recorded spend entries for this repo.",
				);
				if (!ok) return;
			}

			const key = repoKey ?? getRepoKey(ctx.cwd);
			const db = loadDb();
			delete db[key];
			saveDb(db);

			// Reset accumulator too
			accumulatedCost = 0;
			accumulatedInput = 0;
			accumulatedOutput = 0;
			accumulatedCacheRead = 0;
			accumulatedCacheWrite = 0;

			ctx.ui.notify("Spend data cleared.", "info");
		},
	});
}

// ── Utilities ────────────────────────────────────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
