/**
 * Carbon profiler IPC handlers (#365).
 *
 * Every channel takes a project the person added (`resolveKnownProject`, S6)
 * and checked values only: a month, an export format, settings of the known
 * shape. The runner reads the ledger and does the sums (`main/carbon/runner.ts`).
 *
 *   invoke "carbonProfiler:run"     → { projectPath, month?, backfill? }
 *   invoke "carbonProfiler:cancel"  → void
 *   invoke "carbonProfiler:config"  → { projectPath, config }
 *   invoke "carbonProfiler:export"  → { projectPath, month, format } (save dialog)
 *   event  "carbon-profiler-event"  ← progress
 */

import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { CarbonExportFormat } from "../../shared/types/carbon-profiler";
import { getAppLanguage } from "../app-language";
import { readCarbonConfig, startCarbonBudgetChecks } from "../carbon/budget-alerts";
import { FORMATS, MONTH, runCarbon } from "../carbon/runner";
import { showSaveDialog } from "../electron-utils";
import { notificationService } from "../notification-service";
import { projectStore } from "../project-store";
import { resolveKnownProject } from "../security/renderer-path";

type Args = Record<string, unknown> | undefined;

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

function project(args: Args): string {
	const root = resolveKnownProject(args?.projectPath);
	if (!root) throw new Error("Not a project of this app");
	return root;
}

function month(value: unknown): string {
	if (typeof value !== "string" || !MONTH.test(value)) throw new Error("Not a month");
	return value;
}

export function registerCarbonProfilerHandlers(): void {
	let current: ChildProcess | null = null;

	const run = async (root: string, args: string[], progress = false) => {
		const handle = await runCarbon(
			root,
			args,
			progress ? (payload) => broadcast(IPC_CHANNELS.CARBON_PROFILER_EVENT, payload) : undefined,
		);
		if (progress) current = handle.child;
		try {
			return await handle.result;
		} finally {
			if (current === handle.child) current = null;
		}
	};

	ipcMain.handle(IPC_CHANNELS.CARBON_PROFILER_RUN, async (_event, args: Args) => {
		const root = project(args);
		const runArgs: string[] = [];
		if (args?.month !== undefined && args.month !== "") runArgs.push("--month", month(args.month));
		if (args?.backfill === true) runArgs.push("--backfill");
		current?.kill("SIGTERM");
		return run(root, runArgs, true);
	});

	ipcMain.handle(IPC_CHANNELS.CARBON_PROFILER_CANCEL, () => {
		current?.kill("SIGTERM");
		current = null;
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.CARBON_PROFILER_CONFIG, async (_event, args: Args) => {
		const root = project(args);
		const config = readCarbonConfig(args?.config);
		if (!config) throw new Error("Not carbon settings");
		const folder = await mkdtemp(path.join(os.tmpdir(), "workpilot-carbon-"));
		try {
			const file = path.join(folder, "carbon.json");
			await writeFile(file, JSON.stringify(config), "utf-8");
			return await run(root, ["--save-config", file]);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	ipcMain.handle(IPC_CHANNELS.CARBON_PROFILER_EXPORT, async (_event, args: Args) => {
		const root = project(args);
		const chosen = month(args?.month);
		const format = args?.format as CarbonExportFormat;
		if (!FORMATS.includes(format)) throw new Error("Unknown export format");
		const result = (await run(root, ["--export", chosen, "--format", format])) as { content?: unknown };
		if (typeof result?.content !== "string") throw new Error("The export is empty");
		const { canceled, filePath } = await showSaveDialog({
			defaultPath: `carbon-${path.basename(root)}-${chosen}.${format}`.replace(/[^\w.-]/g, "_"),
			filters: [{ name: format.toUpperCase(), extensions: [format] }],
		});
		if (canceled || !filePath) return null;
		await writeFile(filePath, result.content, "utf-8");
		return filePath;
	});
}

/** The budget alerts of the projects that set a budget (`carbon/budget-alerts.ts`). */
export function startCarbonBudgetSchedule(): () => void {
	return startCarbonBudgetChecks({
		projects: () => projectStore.getProjects().map((p) => ({ id: p.id, name: p.name, path: p.path })),
		resolve: (projectPath) => resolveKnownProject(projectPath),
		run: async (root) => (await runCarbon(root, ["--budget-check"])).result,
		announce: (projectId, text) => notificationService.announce(projectId, text),
		language: getAppLanguage,
	});
}
