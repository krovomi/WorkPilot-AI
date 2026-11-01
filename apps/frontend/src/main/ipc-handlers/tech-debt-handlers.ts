/**
 * Tech Debt IPC Handlers.
 *
 * Spawns apps/backend/runners/tech_debt_runner.py to scan a project and
 * score each debt item by ROI = cost / effort.
 *
 * Channels:
 *   invoke "techDebt:scan"       → { projectPath } → { result }
 *   invoke "techDebt:listItems"  → { projectPath, minScore? } → { result }
 *   invoke "techDebt:getTrend"   → { projectPath } → { result }
 *   invoke "techDebt:generateSpec" → { projectPath, itemId, llmHint? } → { result }
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { app, ipcMain } from "electron";
import { pythonEnvManager } from "../python-env-manager.js";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import { runServerAnalysis, serverAnalysisReport, serverProjectAtPath } from "./server-analyses";

interface ScanRequest {
	projectPath: string;
}
interface ListRequest {
	projectPath: string;
	minScore?: number;
}
interface SpecRequest {
	projectPath: string;
	itemId: string;
	llmHint?: string;
}

function resolveBackendPaths(): { backendPath: string; runnerPath: string } {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(
		backendPath,
		"runners",
		"tech_debt_runner.py",
	);
	return { backendPath, runnerPath };
}

async function runRunner(args: string[]): Promise<unknown> {
	const { backendPath, runnerPath } = resolveBackendPaths();
	const pythonExe = pythonEnvManager.getPythonPath();
	if (!pythonExe) return Promise.reject(new Error("Python environment not ready"));

	const env = await pythonRunnerEnv(backendPath);
	return new Promise((resolve, reject) => {
		const child = spawn(pythonExe, [runnerPath, ...args], {
			cwd: backendPath,
			env,
		} as Parameters<typeof spawn>[2]);

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString();
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => {
			const lines = stdout.trim().split("\n").filter(Boolean);
			const last = lines[lines.length - 1] ?? "";
			try {
				const parsed = JSON.parse(last);
				if (parsed.error) return reject(new Error(parsed.error));
				if (code !== 0) {
					return reject(
						new Error(`tech_debt_runner exited with ${code}: ${stderr}`),
					);
				}
				resolve(parsed.result);
			} catch (err) {
				reject(
					new Error(
						`Failed to parse runner output: ${(err as Error).message}`,
					),
				);
			}
		});
	});
}

interface SavedDebt {
	items?: Array<{ roi?: unknown }>;
	trend?: unknown[];
	summary?: unknown;
}

/**
 * A server project's last scan, as the server saved it (`server-analyses.ts`):
 * every member reads the same items and trend.
 */
async function serverDebt(projectPath: string): Promise<SavedDebt | null> {
	const project = serverProjectAtPath(projectPath);
	if (!project) return null;
	const saved = await serverAnalysisReport(project, "tech-debt");
	const report = saved?.report;
	return report && typeof report === "object" ? (report as SavedDebt) : {};
}

export function registerTechDebtHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TECH_DEBT_SCAN, async (_e, req: ScanRequest) => {
		if (!req.projectPath) throw new Error("projectPath is required");
		// A server project's scan runs on the server, its report shared.
		const remote = serverProjectAtPath(req.projectPath);
		if (remote) return { result: await runServerAnalysis(remote, "tech-debt", {}) };
		const result = await runRunner([
			"--project-path",
			req.projectPath,
			"--command",
			"scan",
		]);
		return { result };
	});

	ipcMain.handle(IPC_CHANNELS.TECH_DEBT_LIST_ITEMS, async (_e, req: ListRequest) => {
		if (!req.projectPath) throw new Error("projectPath is required");
		const shared = await serverDebt(req.projectPath);
		if (shared) {
			const minScore = Number(req.minScore ?? 0) || 0;
			const items = Array.isArray(shared.items) ? shared.items : [];
			return {
				result: {
					items: items.filter((item) => Number(item?.roi ?? 0) >= minScore),
					trend: Array.isArray(shared.trend) ? shared.trend : [],
					summary: shared.summary ?? {},
				},
			};
		}
		const args = [
			"--project-path",
			req.projectPath,
			"--command",
			"list",
		];
		if (req.minScore !== undefined) {
			args.push("--min-score", String(req.minScore));
		}
		const result = await runRunner(args);
		return { result };
	});

	ipcMain.handle(IPC_CHANNELS.TECH_DEBT_GET_TREND, async (_e, req: ScanRequest) => {
		if (!req.projectPath) throw new Error("projectPath is required");
		const shared = await serverDebt(req.projectPath);
		if (shared) {
			return { result: { trend: Array.isArray(shared.trend) ? shared.trend : [] } };
		}
		const result = await runRunner([
			"--project-path",
			req.projectPath,
			"--command",
			"trend",
		]);
		return { result };
	});

	ipcMain.handle(IPC_CHANNELS.TECH_DEBT_GENERATE_SPEC, async (_e, req: SpecRequest) => {
		if (!req.projectPath || !req.itemId) {
			throw new Error("projectPath and itemId are required");
		}
		// A spec folder would land in the mirror, which nothing runs: a
		// server project's debt item becomes a card of its board instead.
		if (serverProjectAtPath(req.projectPath)) {
			throw new Error("Create a task from the item: its spec lives on the server");
		}
		const args = [
			"--project-path",
			req.projectPath,
			"--command",
			"spec",
			"--item-id",
			req.itemId,
		];
		if (req.llmHint) args.push("--llm-hint", req.llmHint);
		const result = await runRunner(args);
		return { result };
	});
}
