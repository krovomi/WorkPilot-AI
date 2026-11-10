/**
 * Release Coordinator and Release Train IPC handlers (#362).
 *
 * Every channel takes a project the person added (`resolveKnownProject`, S6)
 * and checked values only (`main/release-train/approvals.ts`). The runner runs
 * without a shell (S4). A train run starts or moves on only when the train
 * file's hash, computed here, is the one the person approved; the runner
 * receives that hash and checks it again before running anything. A run's
 * commands get the project variables the train file names, nothing else (S1).
 *
 *   invoke "releaseCoordinator:run"     → { projectPath, maxCommits? }   version plan
 *   invoke "releaseCoordinator:cancel"  → void
 *   invoke "releaseTrain:state"         → { projectPath }                file, approval, runs
 *   invoke "releaseTrain:approve"       → { projectPath, sha256 }
 *   invoke "releaseTrain:start"         → { projectPath, environment, services?, express? }
 *   invoke "releaseTrain:advance"       → { projectPath, runId, action, target? }
 *   invoke "releaseTrain:run"           → { projectPath, runId }         with its journal
 *   invoke "releaseTrain:metrics"       → { projectPath }
 *   invoke "releaseTrain:notes"         → { projectPath, ai? }
 *
 * Renderer events: release-coordinator-event / -result / -error (the plan),
 * release-train-event ({ projectPath, kind, service?, step? }) while a run moves.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { TrainState, TrainView } from "../../shared/types/release-train";
import { readMergedProjectEnv } from "../ci-pipeline-service";
import { projectStore } from "../project-store";
import {
	approve,
	approvedHash,
	pickVariables,
	readAction,
	readEnvironment,
	readRunId,
	readServices,
	readTarget,
	trainFileHash,
} from "../release-train/approvals";
import { resolveKnownProject } from "../security/renderer-path";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

type Args = Record<string, unknown> | undefined;

const EVENT_PREFIX = "RELEASE_COORDINATOR_EVENT:";
const RESULT_PREFIX = "RELEASE_COORDINATOR_RESULT:";
const ERROR_PREFIX = "RELEASE_COORDINATOR_ERROR:";

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

function project(args: Args): string {
	const root = resolveKnownProject(args?.projectPath);
	if (!root) throw new Error("Not a project of this app");
	return root;
}

function approvalsFile(): string {
	return path.join(app.getPath("userData"), "release-train-approvals.json");
}

function projectEnv(root: string): Record<string, string> {
	const known = projectStore.getProjects().find((p) => {
		try {
			return realpathSync(p.path) === root;
		} catch {
			return false;
		}
	});
	return known ? readMergedProjectEnv(known) : {};
}

interface Run {
	child: ChildProcess;
	result: Promise<unknown>;
}

async function runRunner(
	root: string,
	args: string[],
	options: { onEvent?: (payload: unknown) => void; extraEnv?: Record<string, string> } = {},
): Promise<Run> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "release_coordinator_runner.py");
	const child = spawn(await requirePythonPath(), [runnerPath, "--project-path", root, ...args], {
		cwd: backendPath,
		env: { ...(await pythonRunnerEnv(backendPath)), ...(options.extraEnv ?? {}) },
	} as Parameters<typeof spawn>[2]);

	let buffer = "";
	let result: unknown = null;
	let errorMessage: string | null = null;
	const readLine = (line: string) => {
		if (line.startsWith(EVENT_PREFIX)) {
			try {
				options.onEvent?.(JSON.parse(line.slice(EVENT_PREFIX.length)));
			} catch (err) {
				console.error("[ReleaseCoordinator] Bad event line:", err);
			}
		} else if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length));
			} catch (err) {
				console.error("[ReleaseCoordinator] Bad result line:", err);
			}
		} else if (line.startsWith(ERROR_PREFIX)) {
			const raw = line.slice(ERROR_PREFIX.length);
			try {
				const parsed: unknown = JSON.parse(raw);
				errorMessage = typeof parsed === "string" ? parsed : raw;
			} catch {
				errorMessage = raw;
			}
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line) readLine(line);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[ReleaseCoordinator] stderr:", chunk.toString());
	});
	const done = new Promise<unknown>((resolve, reject) => {
		child.on("close", (code) => {
			if (code === 0 && result) resolve(result);
			else reject(new Error(errorMessage ?? `release coordinator runner exited with code ${code}`));
		});
		child.on("error", (err) => reject(new Error(`Failed to start release coordinator runner: ${err.message}`)));
	});
	return { child, result: done };
}

async function runOnce(root: string, args: string[], extraEnv?: Record<string, string>): Promise<unknown> {
	const handle = await runRunner(root, args, {
		extraEnv,
		onEvent: (payload) => {
			const event = payload as { type?: string; data?: Record<string, unknown> } | null;
			if (event?.type === "train") {
				broadcast(IPC_CHANNELS.RELEASE_TRAIN_EVENT, { ...(event.data ?? {}), projectPath: root });
			}
		},
	});
	return handle.result;
}

/** The approved hash when it is still the file's; throws otherwise. */
function requireApproval(root: string): string {
	const current = trainFileHash(root);
	if (!current) throw new Error("the project has no release-train.yaml");
	if (approvedHash(approvalsFile(), root) !== current) {
		throw new Error("not_approved: the train file changed since you approved it");
	}
	return current;
}

/** The variables a run hands to its commands and flags, as the train file names them. */
async function runVariables(root: string): Promise<Record<string, string>> {
	const view = (await runOnce(root, ["--train"])) as TrainView;
	return pickVariables(projectEnv(root), view.variables);
}

export function registerReleaseCoordinatorHandlers(): void {
	let currentPlan: ChildProcess | null = null;

	const killPlan = (): void => {
		currentPlan?.kill("SIGTERM");
		currentPlan = null;
	};

	ipcMain.handle(IPC_CHANNELS.RELEASE_COORDINATOR_RUN, async (_event, args: Args) => {
		killPlan();
		let root: string;
		try {
			root = project(args);
		} catch (err) {
			broadcast(IPC_CHANNELS.RELEASE_COORDINATOR_ERROR, (err as Error).message);
			throw err;
		}
		const raw = Number(args?.maxCommits ?? 100);
		const maxCommits = Number.isInteger(raw) && raw >= 1 && raw <= 5000 ? raw : 100;
		const handle = await runRunner(root, ["--max-commits", String(maxCommits)], {
			onEvent: (payload) => broadcast(IPC_CHANNELS.RELEASE_COORDINATOR_EVENT, payload),
		});
		currentPlan = handle.child;
		try {
			const result = await handle.result;
			broadcast(IPC_CHANNELS.RELEASE_COORDINATOR_RESULT, result);
			return result;
		} catch (err) {
			broadcast(IPC_CHANNELS.RELEASE_COORDINATOR_ERROR, (err as Error).message);
			throw err;
		} finally {
			if (currentPlan === handle.child) currentPlan = null;
		}
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_COORDINATOR_CANCEL, () => {
		killPlan();
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_STATE, async (_event, args: Args): Promise<TrainState> => {
		const root = project(args);
		const hash = trainFileHash(root);
		if (!hash) return { present: false, approved: false };
		try {
			const view = (await runOnce(root, ["--train"])) as TrainView;
			return {
				present: true,
				approved: view.sha256 === hash && approvedHash(approvalsFile(), root) === hash,
				view,
			};
		} catch (err) {
			return { present: true, approved: false, error: (err as Error).message };
		}
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_APPROVE, (_event, args: Args) =>
		approve(approvalsFile(), project(args), args?.sha256),
	);

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_START, async (_event, args: Args) => {
		const root = project(args);
		const environment = readEnvironment(args?.environment);
		const services = readServices(args?.services);
		if (!environment || services === null) throw new Error("Invalid release train request");
		const hash = requireApproval(root);
		const command = ["--start", environment, "--approved-hash", hash];
		if (services.length) command.push("--services", services.join(","));
		if (args?.express === true) command.push("--express");
		return runOnce(root, command, await runVariables(root));
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_ADVANCE, async (_event, args: Args) => {
		const root = project(args);
		const runId = readRunId(args?.runId);
		const action = readAction(args?.action);
		const target = readTarget(args?.target);
		if (!runId || !action || target === null) throw new Error("Invalid release train request");
		const hash = requireApproval(root);
		const command = ["--advance", runId, "--action", action, "--approved-hash", hash];
		if (target) command.push("--target", target);
		return runOnce(root, command, await runVariables(root));
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_RUN, async (_event, args: Args) => {
		const root = project(args);
		const runId = readRunId(args?.runId);
		if (!runId) throw new Error("Invalid release train request");
		return runOnce(root, ["--run", runId]);
	});

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_METRICS, async (_event, args: Args) =>
		runOnce(project(args), ["--metrics"]),
	);

	ipcMain.handle(IPC_CHANNELS.RELEASE_TRAIN_NOTES, async (_event, args: Args) =>
		runOnce(project(args), args?.ai === true ? ["--notes", "--ai"] : ["--notes"]),
	);
}
