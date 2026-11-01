/**
 * The analyses of a server project (server mode): accessibility, i18n,
 * documentation drift, flaky tests, technical debt.
 *
 * A local project's analysis runs its runner on this computer, in the
 * project's folder. A server project has no folder here: its analysis runs
 * on the server, as a job on the project's clone
 * (`shared_features/analyses.py`), and its report is saved there, so every
 * member reads the last one. The views name their project by its folder: the
 * mirror of a server project's folder sends the analysis to the server
 * (`serverProjectAtPath`), never a path.
 */

import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { Project } from "../../shared/types";
import { authedFetch } from "../server-connection";
import { type AnalysisKind, relayServerJob } from "../server-features";
import { serverProjectAtPath } from "../server-projects";

/** How each runner marks its progress events and its error, if it does. */
const PREFIX: Readonly<Record<AnalysisKind, string | null>> = {
	accessibility: "A11Y",
	i18n: "I18N",
	"doc-drift": "DOC_DRIFT",
	"flaky-tests": "FLAKY",
	"tech-debt": null,
};

const KINDS = new Set<string>(Object.keys(PREFIX));

export function isAnalysisKind(value: unknown): value is AnalysisKind {
	return typeof value === "string" && KINDS.has(value);
}

/** The last report of an analysis, as the server saved it. */
export interface SharedAnalysisReport {
	report: unknown;
	finishedAt: string | null;
	runBy: string | null;
}

/** The analyses running on the server from here, one per analysis. */
const running = new Map<AnalysisKind, { kill(): boolean }>();

export { serverProjectAtPath };

/** The last saved report of an analysis of a server project; null if none. */
export async function serverAnalysisReport(
	project: Project,
	kind: AnalysisKind,
): Promise<SharedAnalysisReport | null> {
	const result = await authedFetch<{ report?: unknown }>(
		`/api/features/analyses/${kind}/report?project_id=${encodeURIComponent(project.id)}`,
		"GET",
	);
	const text = result.ok ? result.data?.report : null;
	if (typeof text !== "string") return null;
	try {
		const saved: unknown = JSON.parse(text);
		if (!saved || typeof saved !== "object" || !("report" in saved)) return null;
		const { report, finished_at, run_by } = saved as Record<string, unknown>;
		return {
			report,
			finishedAt: typeof finished_at === "string" ? finished_at : null,
			runBy: typeof run_by === "string" ? run_by : null,
		};
	} catch {
		return null;
	}
}

/** Stop the analysis running on the server from here; false if none runs. */
export function cancelServerAnalysis(kind: AnalysisKind): boolean {
	const job = running.get(kind);
	if (!job) return false;
	running.delete(kind);
	return job.kill();
}

/**
 * Run an analysis of a server project on the server, telling `onEvent` its
 * progress as the runner prints it; the saved report once it is done.
 */
export function runServerAnalysis(
	project: Project,
	kind: AnalysisKind,
	options: Record<string, unknown>,
	onEvent?: (payload: unknown) => void,
): Promise<unknown> {
	cancelServerAnalysis(kind);
	const prefix = PREFIX[kind];
	const job = relayServerJob(project, `analyses/${kind}`, { options });
	running.set(kind, job);
	let failure: string | null = null;
	const errors: string[] = [];
	job.stdout.on("data", (data: Buffer) => {
		if (!prefix) return;
		for (const raw of data.toString("utf-8").split("\n")) {
			const line = raw.trim();
			if (line.startsWith(`${prefix}_EVENT:`)) {
				try {
					onEvent?.(JSON.parse(line.slice(prefix.length + 7)));
				} catch {
					// A cut or garbled event line: the next one says more.
				}
			} else if (line.startsWith(`${prefix}_ERROR:`)) {
				failure = line.slice(prefix.length + 7);
			}
		}
	});
	job.stderr.on("data", (data: Buffer) => {
		errors.push(data.toString("utf-8").trim());
	});
	return new Promise((resolve, reject) => {
		job.on("exit", (code: number | null) => {
			if (running.get(kind) === job) running.delete(kind);
			if (code === null) {
				reject(new Error("The analysis was stopped"));
				return;
			}
			if (code !== 0) {
				reject(
					new Error(
						failure ?? (errors.filter(Boolean).join("\n") || "The analysis failed on the server"),
					),
				);
				return;
			}
			serverAnalysisReport(project, kind).then(
				(saved) =>
					saved
						? resolve(saved.report)
						: reject(new Error("The analysis ended without a report")),
				reject,
			);
		});
	});
}

/**
 * Run a view's analysis of a server project on the server and tell every
 * window, on the view's own channels, as its local runner's handler does:
 * its progress, then its report or the error.
 */
export async function relayServerAnalysis(
	project: Project,
	kind: AnalysisKind,
	options: Record<string, unknown>,
	channels: { event: string; result: string; error: string },
): Promise<unknown> {
	const broadcast = (channel: string, payload: unknown) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(channel, payload);
		}
	};
	try {
		const report = await runServerAnalysis(project, kind, options, (payload) =>
			broadcast(channels.event, payload),
		);
		broadcast(channels.result, report);
		return report;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		broadcast(channels.error, message);
		throw new Error(message);
	}
}

/**
 * The last report a member saved of a view's analysis, for a server project;
 * null for a local project, which keeps none.
 */
export function registerServerAnalysisHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.ANALYSIS_SHARED_REPORT,
		async (_event, kind: unknown, projectPath: unknown) => {
			const project = serverProjectAtPath(projectPath);
			if (!project || !isAnalysisKind(kind)) return null;
			return serverAnalysisReport(project, kind);
		},
	);
}
