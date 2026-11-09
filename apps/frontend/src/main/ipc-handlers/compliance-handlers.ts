/**
 * Compliance IPC handlers (#357).
 *
 * Every channel takes a project the person added (`resolveKnownProject`, S6)
 * and checked values only: a framework id, a month, a report file name, a
 * config of known shape. The runner does the work (`main/compliance/runner.ts`);
 * the last report it returned stays here, and is the one a JSON export
 * writes, so the renderer never supplies the data of an audit file.
 *
 *   invoke "compliance:run"        → { projectPath, framework, period?, save? }
 *   invoke "compliance:cancel"     → void
 *   invoke "compliance:frameworks" → { projectPath }
 *   invoke "compliance:reports"    → { projectPath }
 *   invoke "compliance:load"       → { projectPath, name }
 *   invoke "compliance:config"     → { projectPath, config }
 *   invoke "compliance:export"     → { format, document, language }
 *   event  "compliance-event"      ← progress
 */

import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { getAppLanguage } from "../app-language";
import { readConfig, startMonthlyCompliance } from "../compliance/monthly";
import { readFormat, writeExport } from "../compliance/report-export";
import { FRAMEWORK_ID, PERIOD, REPORT_NAME, runCompliance } from "../compliance/runner";
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

export function registerComplianceHandlers(): void {
	let current: ChildProcess | null = null;
	let lastReport: unknown = null;

	const run = async (root: string, args: string[], progress = false) => {
		const handle = await runCompliance(
			root,
			args,
			progress ? (payload) => broadcast(IPC_CHANNELS.COMPLIANCE_EVENT, payload) : undefined,
		);
		if (progress) current = handle.child;
		try {
			return await handle.result;
		} finally {
			if (current === handle.child) current = null;
		}
	};

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_RUN, async (_event, args: Args) => {
		const root = project(args);
		const framework = args?.framework;
		if (typeof framework !== "string" || !FRAMEWORK_ID.test(framework)) throw new Error("Unknown framework");
		const runArgs = ["--framework", framework];
		if (args?.period !== undefined) {
			if (typeof args.period !== "string" || !PERIOD.test(args.period)) throw new Error("Not a month");
			runArgs.push("--period", args.period);
		}
		if (args?.save === true) runArgs.push("--save");
		current?.kill("SIGTERM");
		lastReport = await run(root, runArgs, true);
		return lastReport;
	});

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_CANCEL, () => {
		current?.kill("SIGTERM");
		current = null;
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_FRAMEWORKS, (_event, args: Args) => run(project(args), ["--frameworks"]));

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_REPORTS, (_event, args: Args) => run(project(args), ["--list"]));

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_LOAD, async (_event, args: Args) => {
		const root = project(args);
		if (typeof args?.name !== "string" || !REPORT_NAME.test(args.name)) throw new Error("Not a report");
		lastReport = await run(root, ["--load", args.name]);
		return lastReport;
	});

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_CONFIG, async (_event, args: Args) => {
		const root = project(args);
		const config = readConfig(args?.config);
		if (!config) throw new Error("Not a compliance configuration");
		const folder = await mkdtemp(path.join(os.tmpdir(), "workpilot-compliance-"));
		try {
			const file = path.join(folder, "config.json");
			await writeFile(file, JSON.stringify(config), "utf-8");
			return await run(root, ["--config", file]);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	ipcMain.handle(IPC_CHANNELS.COMPLIANCE_EXPORT, async (_event, args: Args) => {
		const format = readFormat(args?.format);
		if (!format) throw new Error("Unknown export format");
		if (!lastReport) throw new Error("No report to export");
		const report = lastReport as { framework?: { id?: unknown }; period?: { label?: unknown } };
		const id = typeof report.framework?.id === "string" ? report.framework.id : "compliance";
		const month = typeof report.period?.label === "string" ? report.period.label : "report";
		const { canceled, filePath } = await showSaveDialog({
			defaultPath: `${id}-${month}.${format}`.replace(/[^\w.-]/g, "_"),
			filters: [{ name: format.toUpperCase(), extensions: [format] }],
		});
		if (canceled || !filePath) return null;
		const language = typeof args?.language === "string" ? args.language : getAppLanguage();
		await writeExport(format, { report: lastReport, document: args?.document, language }, filePath);
		return filePath;
	});
}

/** The monthly reports of the projects that asked for them (`compliance/monthly.ts`). */
export function startComplianceSchedule(): () => void {
	return startMonthlyCompliance({
		projects: () => projectStore.getProjects().map((p) => ({ id: p.id, name: p.name, path: p.path })),
		resolve: (projectPath) => resolveKnownProject(projectPath),
		run: async (root) => (await runCompliance(root, ["--monthly"])).result,
		announce: (projectId, text) => notificationService.announce(projectId, text),
		language: getAppLanguage,
	});
}
