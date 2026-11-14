/**
 * Cost Estimator IPC Handlers
 *
 * Reads/writes {projectPath}/.workpilot/cost_data.json directly in Node.js
 * to expose cost summary and budget info to the renderer without needing a
 * Python HTTP server. Spend is read from every ledger of the project, root and
 * task workspaces (`workspace-ledgers.ts`); budgets live in the root file.
 */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { logger } from "../app-logger";
import { projectStore } from "../project-store";
import {
	buildDashboardSnapshot,
	COST_DATA_FILE,
	type LedgerUsage,
	readUsages,
	SNAPSHOT_FILE,
} from "../workspace-ledgers";

// ---------------------------------------------------------------------------
// Load all configured provider IDs from configured_providers.json
// so we can show $0 entries for providers with no usage.
// ---------------------------------------------------------------------------

function loadConfiguredProviderIds(): string[] {
	// configured_providers.json is at the repo root.
	// app.getAppPath() can point to different directories depending on dev vs packaged mode,
	// so we try multiple candidates including process.cwd() for dev mode.
	const appPath = app.getAppPath();
	const cwd = process.cwd();
	const candidates = [
		// Dev mode: process.cwd() is typically apps/frontend
		path.join(cwd, "..", "..", "config", "configured_providers.json"),
		path.join(cwd, "..", "config", "configured_providers.json"),
		path.join(cwd, "config", "configured_providers.json"),
		// app.getAppPath()-based (works in various electron-vite configurations)
		path.join(appPath, "..", "..", "..", "config", "configured_providers.json"),
		path.join(appPath, "..", "..", "config", "configured_providers.json"),
		path.join(appPath, "..", "config", "configured_providers.json"),
		path.join(appPath, "config", "configured_providers.json"),
		// Fallback: src dir
		path.join(appPath, "src", "config", "configured_providers.json"),
	];
	for (const p of candidates) {
		try {
			if (!fs.existsSync(p)) continue;
			const raw = fs.readFileSync(p, "utf-8");
			const parsed = JSON.parse(raw) as {
				providers?: { id?: string; name?: string }[];
			};
			const ids = (parsed.providers ?? [])
				.map((pv) => pv.id ?? pv.name ?? "")
				.filter(Boolean);
			if (ids.length > 0) return ids;
		} catch {
			// try next
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// Watcher — the project's .workpilot folder, where every task now records its
// spend: COSTS_DATA_UPDATED when cost_data.json changes, DASHBOARD_SNAPSHOT_UPDATED
// when it or dashboard_snapshot.json does (the dashboard reads both).
// ---------------------------------------------------------------------------

const _watchers = new Map<string, fs.FSWatcher>();
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function notifyWindows(channel: string, projectPath: string): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, projectPath);
	}
}

function debounce(key: string, run: () => void): void {
	// Coalesce rapid events (an atomic rename fires twice on Windows).
	const existing = _debounceTimers.get(key);
	if (existing) clearTimeout(existing);
	_debounceTimers.set(
		key,
		setTimeout(() => {
			_debounceTimers.delete(key);
			run();
		}, 400),
	);
}

function watchLedgers(projectPath: string): void {
	if (_watchers.has(projectPath)) return;
	const dir = path.join(projectPath, ".workpilot");
	if (!fs.existsSync(dir)) return;
	try {
		const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
			const name = filename ? String(filename) : "";
			if (name === COST_DATA_FILE) {
				debounce(`${projectPath}:costs`, () =>
					notifyWindows(IPC_CHANNELS.COSTS_DATA_UPDATED, projectPath),
				);
			}
			if (name === COST_DATA_FILE || name === SNAPSHOT_FILE) {
				debounce(`${projectPath}:dashboard`, () =>
					notifyWindows(IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED, projectPath),
				);
			}
		});
		watcher.on("error", () => {
			watcher.close();
			_watchers.delete(projectPath);
		});
		_watchers.set(projectPath, watcher);
	} catch {
		// Silently ignore — watcher is best-effort
	}
}

/** The board's tasks of the project at `projectPath`, or none if it is not registered. */
function boardTasks(projectPath: string) {
	const wanted = path.resolve(projectPath);
	const project = projectStore
		.getProjects()
		.find((p) => path.resolve(p.path) === wanted);
	return project ? projectStore.getTasks(project.id) : [];
}

// ---------------------------------------------------------------------------
// JSON file shape (mirrors Python CostEstimator.save_to_file)
// ---------------------------------------------------------------------------

interface RawBudget {
	project_id: string;
	limit: number;
	currency: string;
	warning_threshold: number;
	critical_threshold: number;
	period: string;
}

interface CostDataFile {
	usages: unknown[];
	budgets: Record<string, RawBudget>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCostDataPath(projectPath: string): string {
	return path.join(projectPath, ".workpilot", COST_DATA_FILE);
}

function loadCostData(projectPath: string): CostDataFile {
	const filePath = getCostDataPath(projectPath);
	if (!fs.existsSync(filePath)) {
		return { usages: [], budgets: {} };
	}
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as CostDataFile;
	} catch (err) {
		logger.warn("[costs] Failed to parse cost_data.json", err);
		return { usages: [], budgets: {} };
	}
}

function saveCostData(projectPath: string, data: CostDataFile): void {
	const filePath = getCostDataPath(projectPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function getPeriodStart(period: string): Date | null {
	const now = new Date();
	if (period === "monthly") {
		return new Date(now.getFullYear(), now.getMonth(), 1);
	}
	if (period === "weekly") {
		const start = new Date(now);
		start.setDate(now.getDate() - now.getDay());
		start.setHours(0, 0, 0, 0);
		return start;
	}
	return null; // 'total' — no filter
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerCostHandlers(): void {
	/**
	 * costs:getSummary — returns cost summary for the last 30 days
	 */
	ipcMain.handle(IPC_CHANNELS.COSTS_GET_SUMMARY, async (_, projectPath: string) => {
		try {
			watchLedgers(projectPath); // Start watching on first access
			const usages = readUsages(projectPath);
			const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
			const since60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

			const recent = usages.filter(
				(u) => new Date(u.timestamp) >= since30,
			);
			const previous = usages.filter(
				(u) =>
					new Date(u.timestamp) >= since60 && new Date(u.timestamp) < since30,
			);

			const totalCost = recent.reduce((s, u) => s + u.cost, 0);
			const prevCost = previous.reduce((s, u) => s + u.cost, 0);
			const tokensInput = recent.reduce((s, u) => s + u.input_tokens, 0);
			const tokensOutput = recent.reduce((s, u) => s + u.output_tokens, 0);

			const byProvider: Record<string, number> = {};
			const byModel: Record<string, number> = {};
			for (const u of recent) {
				byProvider[u.provider] = (byProvider[u.provider] ?? 0) + u.cost;
				const modelKey = `${u.provider}/${u.model}`;
				byModel[modelKey] = (byModel[modelKey] ?? 0) + u.cost;
			}

			// Add all configured providers with $0 if they have no usage yet
			for (const pid of loadConfiguredProviderIds()) {
				if (!(pid in byProvider)) byProvider[pid] = 0;
			}

			// Compute actual span of data in the window (more accurate than a hardcoded 30)
			let periodDays = 30;
			if (recent.length > 0) {
				const timestamps = recent.map((u) => new Date(u.timestamp).getTime());
				const oldest = Math.min(...timestamps);
				const newest = Math.max(...timestamps);
				const spanDays =
					Math.ceil((newest - oldest) / (24 * 60 * 60 * 1000)) + 1;
				periodDays = Math.max(1, Math.min(30, spanDays));
			}
			const dailyAvg = totalCost / periodDays;
			const trendPct =
				prevCost > 0 ? ((totalCost - prevCost) / prevCost) * 100 : 0;

			return {
				success: true,
				summary: {
					total_cost: totalCost,
					cost_by_provider: byProvider,
					cost_by_model: byModel,
					total_tokens: tokensInput + tokensOutput,
					tokens_input: tokensInput,
					tokens_output: tokensOutput,
					period_days: periodDays,
					daily_avg: dailyAvg,
					trend_pct: trendPct,
				},
			};
		} catch (err) {
			logger.error("[costs] getSummary failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * costs:getContextUsage — retourne le remplissage de fenêtre de contexte de
	 * la dernière requête d'un provider (proxy de la « session courante »).
	 *
	 * `contextTokens` = input_tokens du dernier enregistrement (les tokens
	 * effectivement envoyés au modèle = remplissage du contexte au dernier tour).
	 * Sert à afficher un « % de contexte consommé » façon Claude Code.
	 */
	ipcMain.handle(
		IPC_CHANNELS.COSTS_GET_CONTEXT_USAGE,
		async (_, projectPath: string, provider: string) => {
			try {
				watchLedgers(projectPath);

				let latest: LedgerUsage | null = null;
				for (const u of readUsages(projectPath)) {
					if (u.provider !== provider) continue;
					if (
						latest === null ||
						new Date(u.timestamp) > new Date(latest.timestamp)
					) {
						latest = u;
					}
				}

				if (!latest) {
					return { success: true, contextUsage: null };
				}

				return {
					success: true,
					contextUsage: {
						provider: latest.provider,
						model: latest.model,
						contextTokens: latest.input_tokens,
						outputTokens: latest.output_tokens,
						timestamp: latest.timestamp,
					},
				};
			} catch (err) {
				logger.error("[costs] getContextUsage failed", err);
				return { success: false, error: String(err) };
			}
		},
	);

	/**
	 * costs:getBudget — returns budget info for the current period
	 */
	ipcMain.handle(IPC_CHANNELS.COSTS_GET_BUDGET, async (_, projectPath: string) => {
		try {
			const data = loadCostData(projectPath);
			// Use project path as key (same convention as Python CostEstimator)
			const budget = data.budgets[projectPath];
			if (!budget) {
				return { success: false, error: "No budget configured" };
			}

			const periodStart = getPeriodStart(budget.period);
			const usages = readUsages(projectPath);
			const relevant = periodStart
				? usages.filter((u) => new Date(u.timestamp) >= periodStart)
				: usages;

			const spent = relevant.reduce((s, u) => s + u.cost, 0);
			const remaining = Math.max(0, budget.limit - spent);
			const utilizationPct =
				budget.limit > 0 ? (spent / budget.limit) * 100 : 0;

			// Forecast end-of-month
			let forecastEndOfMonth = 0;
			if (budget.period === "monthly") {
				const now = new Date();
				const daysInMonth = new Date(
					now.getFullYear(),
					now.getMonth() + 1,
					0,
				).getDate();
				const dayOfMonth = now.getDate();
				forecastEndOfMonth =
					dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0;
			}

			// Build alert messages
			const alerts: string[] = [];
			const pct = utilizationPct / 100;
			if (pct >= 1) {
				alerts.push(
					`Budget dépassé ! Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)}`,
				);
			} else if (pct >= budget.critical_threshold) {
				alerts.push(
					`Critique : proche du plafond. Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)} (${utilizationPct.toFixed(0)}%)`,
				);
			} else if (pct >= budget.warning_threshold) {
				alerts.push(
					`Attention : utilisation élevée. Dépensé $${spent.toFixed(2)} / $${budget.limit.toFixed(2)} (${utilizationPct.toFixed(0)}%)`,
				);
			}

			return {
				success: true,
				budget: {
					monthly_budget: budget.limit,
					spent_this_month: spent,
					remaining,
					utilization_pct: utilizationPct,
					alerts,
					forecast_end_of_month: forecastEndOfMonth,
				},
			};
		} catch (err) {
			logger.error("[costs] getBudget failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * dashboard:getSnapshot — the project's tasks from the board, its spend,
	 * QA, merges and build times from every ledger it keeps (root and task
	 * workspaces, `workspace-ledgers.ts`).
	 */
	ipcMain.handle(IPC_CHANNELS.DASHBOARD_GET_SNAPSHOT, async (_, projectPath: string) => {
		try {
			watchLedgers(projectPath); // Start watching on first access
			return {
				success: true,
				snapshot: buildDashboardSnapshot(projectPath, boardTasks(projectPath)),
			};
		} catch (err) {
			logger.error("[dashboard] getSnapshot failed", err);
			return { success: false, error: String(err) };
		}
	});

	/**
	 * costs:setBudget — create/update budget for a project
	 */
	ipcMain.handle(
		IPC_CHANNELS.COSTS_SET_BUDGET,
		async (
			_,
			projectPath: string,
			limit: number,
			period: string = "monthly",
		) => {
			try {
				const data = loadCostData(projectPath);
				data.budgets[projectPath] = {
					project_id: projectPath,
					limit,
					currency: "USD",
					warning_threshold: 0.75,
					critical_threshold: 0.9,
					period,
				};
				saveCostData(projectPath, data);
				return { success: true };
			} catch (err) {
				logger.error("[costs] setBudget failed", err);
				return { success: false, error: String(err) };
			}
		},
	);
}
