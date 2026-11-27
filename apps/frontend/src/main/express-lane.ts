/**
 * Express lane: a project's own Dependabot and Renovate pull requests, merged
 * by themselves when their approval tier is N0 (docs/architecture/express-lane.md).
 *
 * Every half hour, when the setting `expressLane` is on and the approval tiers
 * enforce, the main process starts `runners/express_lane_runner.py` once per
 * local project, one after the other. The runner lists the project's open bot
 * PRs on GitHub, judges each green one with the approvals engine, and merges
 * at the head it judged when the tier allows it; this module only logs what it
 * prints. A project under the strict offline mode, a server project and a
 * worktree are never given to it.
 *
 * The settings are read again at each look: turning the lane off, or the tiers
 * back to observe, stops the next pass without a restart.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import type { Project } from "../shared/types";
import { normalizeApprovalTierMode } from "../shared/utils/approval-tiers";
import { approvalsEnv } from "./agent/approvals-env";
import { appLog } from "./app-logger";
import { offlineStrict } from "./ipc-handlers/task/split-merge-watch";
import { projectStore } from "./project-store";
import { parsePythonCommand } from "./python-detector";
import { readSettingsFile } from "./settings-utils";
import { readyPythonPath } from "./utils/ensure-python";
import { pythonRunnerEnv } from "./utils/python-runner-env";

const RUNNER = "express_lane_runner.py";
const FIRST_LOOK_MS = 3 * 60_000;
const EVERY_MS = 30 * 60_000;
/** A runner that has not finished by then is stopped; the next look starts over. */
const RUN_TIMEOUT_MS = 10 * 60_000;

export interface ExpressLaneOutcome {
	seen: number;
	merged: number;
	error?: string;
	skipped?: string;
}

export interface ExpressLaneDeps {
	settings: () => Record<string, unknown> | undefined;
	projects: () => readonly Project[];
	offline: (projectPath: string) => boolean;
	run: (project: Project, settings: Record<string, unknown>) => Promise<ExpressLaneOutcome>;
}

/** On only when the person turned it on and the tiers enforce. */
export function expressLaneEnabled(settings: Record<string, unknown> | undefined): boolean {
	return (
		settings?.expressLane === true &&
		normalizeApprovalTierMode(settings?.approvalTiers) === "enforce"
	);
}

const count = (value: unknown): number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value ? value.slice(0, 300) : undefined;

/** What the runner printed, folded into one outcome. Unknown lines are ignored. */
export function parseRunnerOutput(stdout: string): ExpressLaneOutcome {
	const outcome: ExpressLaneOutcome = { seen: 0, merged: 0 };
	let finished = false;
	for (const line of stdout.split("\n")) {
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!row || typeof row !== "object") continue;
		const { result, error } = row as { result?: unknown; error?: unknown };
		if (result && typeof result === "object") {
			const r = result as Record<string, unknown>;
			outcome.seen = count(r.seen);
			outcome.merged = count(r.merged);
			outcome.error = text(r.error);
			outcome.skipped = text(r.skipped);
			finished = true;
		} else if (text(error)) {
			outcome.error = text(error);
			finished = true;
		}
	}
	if (!finished) outcome.error = "the express lane stopped without a result";
	return outcome;
}

/** The local projects the lane may look at. */
export function laneProjects(
	projects: readonly Project[],
	offline: (projectPath: string) => boolean,
): Project[] {
	return projects.filter((p) => Boolean(p.path) && !p.remote && !offline(p.path));
}

/** One pass: each project in turn, when the lane is on. The number merged. */
export async function expressLanePass(deps: ExpressLaneDeps): Promise<number> {
	const settings = deps.settings();
	if (!settings || !expressLaneEnabled(settings)) return 0;
	let merged = 0;
	for (const project of laneProjects(deps.projects(), deps.offline)) {
		let outcome: ExpressLaneOutcome;
		try {
			outcome = await deps.run(project, settings);
		} catch (error) {
			outcome = {
				seen: 0,
				merged: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		merged += outcome.merged;
		if (outcome.error) {
			appLog.warn(`[EXPRESS] ${project.name}: ${outcome.error}`);
		} else if (outcome.seen > 0) {
			appLog.info(
				`[EXPRESS] ${project.name}: ${outcome.merged} of ${outcome.seen} dependency PRs merged`,
			);
		}
	}
	return merged;
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** The runner for one project: its own process, argument list, no shell. */
export async function runExpressLane(
	project: Project,
	settings: Record<string, unknown>,
): Promise<ExpressLaneOutcome> {
	const pythonPath = await readyPythonPath();
	if (!pythonPath) return { seen: 0, merged: 0, error: "Python environment not ready" };
	const backend = backendPath();
	// A bot's N0 bump needs no review: Claude Ship is never asked, so the
	// Claude profiles are not read for it.
	const env = await pythonRunnerEnv(backend, { extra: approvalsEnv(settings, () => false) });
	const [command, baseArgs] = parsePythonCommand(pythonPath);
	const args = [
		...baseArgs,
		path.join(backend, "runners", RUNNER),
		"--project-dir",
		project.path,
	];
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, { cwd: backend, env, windowsHide: true });
		} catch (error) {
			resolve({
				seen: 0,
				merged: 0,
				error: error instanceof Error ? error.message : "Failed to start",
			});
			return;
		}
		let stdout = "";
		const stop = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
		stop.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[EXPRESS]", chunk.toString().trim());
		});
		child.on("error", (error) => {
			clearTimeout(stop);
			resolve({ seen: 0, merged: 0, error: error.message });
		});
		child.on("close", () => {
			clearTimeout(stop);
			resolve(parseRunnerOutput(stdout));
		});
	});
}

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let looking = false;

export function startExpressLane(): void {
	if (timer) return;
	const deps: ExpressLaneDeps = {
		settings: () => readSettingsFile(),
		projects: () => projectStore.getProjects(),
		offline: offlineStrict,
		run: runExpressLane,
	};
	const look = async () => {
		if (looking) return;
		looking = true;
		try {
			await expressLanePass(deps);
		} catch (error) {
			appLog.warn(
				`[EXPRESS] The pass failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			looking = false;
		}
	};
	first = setTimeout(() => void look(), FIRST_LOOK_MS);
	timer = setInterval(() => void look(), EVERY_MS);
	first.unref?.();
	timer.unref?.();
}

export function stopExpressLane(): void {
	if (first) clearTimeout(first);
	if (timer) clearInterval(timer);
	first = null;
	timer = null;
}
