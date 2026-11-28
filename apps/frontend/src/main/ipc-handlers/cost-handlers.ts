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
import { BUDGET_FILE, budgetStatus, writeBudget, writeTaskBudget } from "../cost-budget";
import { projectStore } from "../project-store";
import {
	buildDashboardSnapshot,
	COST_DATA_FILE,
	type LedgerUsage,
	readUsages,
	SNAPSHOT_FILE,
} from "../workspace-ledgers";
import { allSpecDirs, getSpecPaths } from "./task/resume-task";
import { findTaskAndProject } from "./task/shared";

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
			if (name === COST_DATA_FILE || name === BUDGET_FILE) {
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

function isRegisteredProject(projectPath: unknown): projectPath is string {
	if (typeof projectPath !== "string" || !projectPath) return false;
	const wanted = path.resolve(projectPath);
	return projectStore.getProjects().some((p) => path.resolve(p.path) === wanted);
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
	 * costs:getBudget — the project's budget and where it stands
	 * (`cost-budget.ts`; the backend enforces the same file).
	 */
	ipcMain.handle(IPC_CHANNELS.COSTS_GET_BUDGET, async (_, projectPath: string) => {
		try {
			watchLedgers(projectPath);
			return { success: true, budget: budgetStatus(projectPath) };
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
	 * costs:setBudget — the project's budget, revalidated here (`parseBudget`)
	 */
	ipcMain.handle(
		IPC_CHANNELS.COSTS_SET_BUDGET,
		async (_, projectPath: string, budget: unknown) => {
			try {
				if (!isRegisteredProject(projectPath)) {
					return { success: false, error: "Unknown project" };
				}
				return { success: true, budget: writeBudget(projectPath, budget) };
			} catch (err) {
				logger.error("[costs] setBudget failed", err);
				return { success: false, error: String(err) };
			}
		},
	);

	/**
	 * costs:setTaskBudget — one task's own limit (0 clears it), in every copy of
	 * its spec directory. A task paused at its budget resumes once it is raised.
	 */
	ipcMain.handle(
		IPC_CHANNELS.COSTS_SET_TASK_BUDGET,
		async (_, projectId: string, taskId: string, amount: unknown) => {
			try {
				if (typeof projectId !== "string" || typeof taskId !== "string") {
					return { success: false, error: "Invalid task" };
				}
				const { task, project } = findTaskAndProject(taskId, projectId);
				if (!task || !project) return { success: false, error: "Task not found" };
				const written = writeTaskBudget(allSpecDirs(getSpecPaths(task, project)), amount);
				return written > 0
					? { success: true }
					: { success: false, error: "Task folder not found" };
			} catch (err) {
				logger.error("[costs] setTaskBudget failed", err);
				return { success: false, error: String(err) };
			}
		},
	);
}
