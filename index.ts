/**
 * Per-Commit Spend Tracker Extension for pi
 *
 * Tracks AI cost per git commit, persisting data across sessions.
 * - Accumulates spend from assistant message usage on `message_end`
 * - Calculates cost from token counts using models.dev pricing when provider returns cost=0
 * - Flushes to JSON DB when `git commit` is detected via `tool_result`
 * - Records pending spend on `session_shutdown`
 * - `/spend` command to view per-commit breakdown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

interface SpendEntry {
	commitHash: string;
	commitMessage: string;
	cost: number;
	calculatedCost: boolean; // AIDEV-NOTE: true if derived from tokens, false if from API
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

interface ModelCost {
	input: number; // $ per 1M tokens
	output: number;
	cache_read?: number;
	cache_write?: number;
}

interface ModelsDevModel {
	id: string;
	cost?: ModelCost;
}

interface ModelsDevProvider {
	id: string;
	models: Record<string, ModelsDevModel>;
}

type ModelsDevDb = Record<string, ModelsDevProvider>;

// ── Constants ────────────────────────────────────────────────────────────

const DB_DIR = path.join(os.homedir(), ".pi", "agent", "data");
const DB_PATH = path.join(DB_DIR, "per-commit-spend.json");
const MODELS_CACHE_PATH = path.join(DB_DIR, "per-commit-spend-models.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Persistence ──────────────────────────────────────────────────────────

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
	return cwd;
}

// ── Models.dev pricing ───────────────────────────────────────────────────

function loadModelsCache(): { db: ModelsDevDb; fetchedAt: number } | null {
	try {
		const data = fs.readFileSync(MODELS_CACHE_PATH, "utf8");
		return JSON.parse(data);
	} catch {
		return null;
	}
}

function saveModelsCache(db: ModelsDevDb): void {
	fs.mkdirSync(DB_DIR, { recursive: true });
	fs.writeFileSync(
		MODELS_CACHE_PATH,
		JSON.stringify({ db, fetchedAt: Date.now() }),
		"utf8",
	);
}

async function fetchModelsDev(): Promise<ModelsDevDb> {
	return new Promise((resolve, reject) => {
		https
			.get(MODELS_DEV_URL, (res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => {
					try {
						resolve(JSON.parse(data) as ModelsDevDb);
					} catch (e) {
						reject(new Error(`Failed to parse models.dev response: ${e}`));
					}
				});
			})
			.on("error", reject);
	});
}

async function ensureModelsCache(): Promise<ModelsDevDb | null> {
	const cached = loadModelsCache();
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.db;
	}

	try {
		const db = await fetchModelsDev();
		saveModelsCache(db);
		return db;
	} catch (e) {
		// AIDEV-NOTE: return stale cache if fetch fails, else null
		if (cached) return cached.db;
		console.error("[per-commit-spend] Failed to fetch models.dev:", e);
		return null;
	}
}

/**
 * Look up pricing for a model ID across all providers in models.dev.
 * Skips providers where cost is { input: 0, output: 0 } (subscription providers).
 * Returns the first provider with real pricing.
 */
function findPricing(modelsDb: ModelsDevDb, modelId: string): ModelCost | null {
	for (const provider of Object.values(modelsDb)) {
		const model = provider.models[modelId];
		if (!model?.cost) continue;
		// AIDEV-NOTE: skip subscription providers that report zero cost
		if (model.cost.input === 0 && model.cost.output === 0) continue;
		return model.cost;
	}
	return null;
}

/**
 * Calculate cost from token counts using pricing data.
 * All prices are per 1M tokens.
 */
function calculateCost(
	pricing: ModelCost,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
): number {
	const cost =
		(input * pricing.input) / 1_000_000 +
		(output * pricing.output) / 1_000_000 +
		(cacheRead * (pricing.cache_read ?? pricing.input)) / 1_000_000 +
		(cacheWrite * (pricing.cache_write ?? pricing.input)) / 1_000_000;
	return cost;
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let accumulatedCost = 0;
	let accumulatedInput = 0;
	let accumulatedOutput = 0;
	let accumulatedCacheRead = 0;
	let accumulatedCacheWrite = 0;
	let accumulatedCalculated = false; // track if any cost was calculated (not from API)

	let repoKey: string | undefined;
	let modelsDb: ModelsDevDb | null = null;
	let currentModelId: string | undefined;

	// ── Resolve model ID ──

	pi.on("model_select", async (event, _ctx) => {
		currentModelId = event.model.id;
	});

	// ── Accumulate spend from each assistant message ──

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		const usage = event.message.usage;
		if (!usage) return;

		const apiCost = usage.cost?.total ?? 0;
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;

		let cost = apiCost;
		let calculated = false;

		// AIDEV-NOTE: If API reports no cost (subscription), calculate from tokens
		if (cost === 0 && (input > 0 || output > 0) && modelsDb && currentModelId) {
			const pricing = findPricing(modelsDb, currentModelId);
			if (pricing) {
				cost = calculateCost(pricing, input, output, cacheRead, cacheWrite);
				calculated = true;
			}
		}

		accumulatedCost += cost;
		accumulatedInput += input;
		accumulatedOutput += output;
		accumulatedCacheRead += cacheRead;
		accumulatedCacheWrite += cacheWrite;
		if (calculated) accumulatedCalculated = true;
	});

	// ── Detect git commit via tool_result ──

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const input = event.input as { command?: string } | undefined;
		const command = input?.command ?? "";
		if (!command) return;

		const isCommit =
			/\bgit\s+commit\b/.test(command) &&
			!/\b--amend\b/.test(command) &&
			!/\b--dry-run\b/.test(command);

		if (!isCommit) return;

		if (accumulatedCost === 0 && accumulatedInput === 0) return;

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
			calculatedCost: accumulatedCalculated,
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

		db[key].entries = db[key].entries.filter((e) => !e.pending);
		db[key].entries.push(entry);
		saveDb(db);

		accumulatedCost = 0;
		accumulatedInput = 0;
		accumulatedOutput = 0;
		accumulatedCacheRead = 0;
		accumulatedCacheWrite = 0;
		accumulatedCalculated = false;

		if (ctx.hasUI) {
			const calcTag = entry.calculatedCost ? " (calculated)" : "";
			ctx.ui.notify(
				`Spend recorded for ${entry.commitHash}: $${entry.cost.toFixed(4)}${calcTag}`,
				"info",
			);
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
			calculatedCost: accumulatedCalculated,
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

	// ── Resolve repo key + load models cache on session start ──

	pi.on("session_start", async (_event, ctx) => {
		const { stdout, code } = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
		});
		if (code === 0) {
			repoKey = stdout.trim();
		} else {
			repoKey = ctx.cwd;
		}

		// Load pending entries into accumulator
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
					if (entry.calculatedCost) accumulatedCalculated = true;
				}
			}
		}

		// AIDEV-NOTE: fetch models.dev pricing in background — non-blocking
		ensureModelsCache().then((db) => {
			modelsDb = db;
			if (db) {
				const modelCount = Object.values(db).reduce(
					(sum, p) => sum + Object.keys(p.models).length,
					0,
				);
				console.error(
					`[per-commit-spend] Loaded pricing for ${modelCount} models from models.dev`,
				);
			}
		});
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
							const calcTag = entry.calculatedCost
								? theme.fg("dim", " (calc)")
								: "";

							if (expanded) {
								lines.push(
									tw(`  ${hash} ${cost}${calcTag}${pending} ${theme.fg("dim", `↑${formatTokens(entry.inputTokens)} ↓${formatTokens(entry.outputTokens)}`)}`),
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
									tw(`  ${hash} ${cost}${calcTag}${pending} ${theme.fg("muted", msg)}`),
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

						if (accumulatedCost > 0) {
							const calcTag = accumulatedCalculated ? " (calc)" : "";
							lines.push(
								tw(`  ${theme.fg("warning", `Current session (uncommitted): $${accumulatedCost.toFixed(4)}${calcTag}`)}`),
							);
							lines.push("");
						}

						// Pricing source status
						if (modelsDb) {
							const modelCount = Object.values(modelsDb).reduce(
								(sum, p) => sum + Object.keys(p.models).length,
								0,
							);
							lines.push(
								tw(theme.fg("dim", `  Pricing: models.dev (${modelCount} models)`)),
							);
						} else {
							lines.push(
								tw(theme.fg("warning", "  Pricing: models.dev unavailable")),
							);
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

			accumulatedCost = 0;
			accumulatedInput = 0;
			accumulatedOutput = 0;
			accumulatedCacheRead = 0;
			accumulatedCacheWrite = 0;
			accumulatedCalculated = false;

			ctx.ui.notify("Spend data cleared.", "info");
		},
	});

	// ── /spend-refresh command ──

	pi.registerCommand("spend-refresh", {
		description: "Force-refresh models.dev pricing cache",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Fetching models.dev pricing...", "info");
			try {
				const db = await fetchModelsDev();
				saveModelsCache(db);
				modelsDb = db;
				const modelCount = Object.values(db).reduce(
					(sum, p) => sum + Object.keys(p.models).length,
					0,
				);
				ctx.ui.notify(`Pricing updated: ${modelCount} models loaded.`, "info");
			} catch (e) {
				ctx.ui.notify(`Failed to fetch pricing: ${e}`, "error");
			}
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
