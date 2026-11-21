/**
 * "How you compare" in Build Analytics, on this computer: a project's specs
 * against its own past and against the person's other registered projects.
 *
 * Runs `runners/build_compare_runner.py` in the managed Python, which reads
 * the ledgers and spec plans in each project's folder
 * (`apps/backend/shared_features/build_compare.py`); nothing leaves the
 * computer. The renderer names the project by its folder, checked before the
 * handler (`DIRECTORY_ARGS`) and again here against the registered projects;
 * the other folders come from the project store, never from the renderer.
 *
 * What the runner prints is checked as a server's answer is
 * (`build-compare-shape.ts`): numbers finite, labels cut, lists bounded.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import type { IPCResult } from "../shared/types";
import type { BuildComparison } from "../shared/types/build-compare";
import { MAX_OTHERS, toBuildComparison } from "./build-compare-shape";
import { projectStore } from "./project-store";
import { requirePythonPath } from "./utils/ensure-python";
import { pythonStaticRunnerEnv } from "./utils/python-runner-env";

const RESULT_PREFIX = "BUILD_COMPARE_RESULT:";
const ERROR_PREFIX = "BUILD_COMPARE_ERROR:";
/** Each project's folder is read, and git counts its files: give it time. */
export const RUN_TIMEOUT_MS = 180_000;
const UNREADABLE = "Unreadable answer from the comparison";

/**
 * The runner's request: the registered project at `projectPath`, and the
 * person's other registered projects; null when the folder is not one.
 */
export function buildComparePayload(projectPath: unknown): string | null {
	if (typeof projectPath !== "string" || !projectPath) return null;
	const wanted = path.resolve(projectPath);
	const projects = projectStore.getProjects();
	const current = projects.find((p) => path.resolve(p.path) === wanted);
	if (!current) return null;
	const others = projects
		.filter((p) => path.resolve(p.path) !== wanted)
		.slice(0, MAX_OTHERS)
		.map((p) => ({ path: path.resolve(p.path), name: p.name }));
	return JSON.stringify({
		current: { path: wanted, name: current.name },
		others,
	});
}

/** The runner's result line, or its error, from its whole stdout. */
export function parseBuildCompareOutput(stdout: string): {
	result?: unknown;
	error?: string;
} {
	let result: unknown;
	let error: string | undefined;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length));
			} catch {
				error = UNREADABLE;
			}
		} else if (line.startsWith(ERROR_PREFIX)) {
			error = line.slice(ERROR_PREFIX.length);
		}
	}
	return { result, error };
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** One comparison per project at a time: a new one replaces the previous. */
const running = new Map<string, ChildProcess>();

/** Compare the registered project at `projectPath` (see the module). */
export async function compareLocalProject(
	projectPath: unknown,
): Promise<IPCResult<BuildComparison>> {
	const payload = buildComparePayload(projectPath);
	if (!payload) return { success: false, error: "Unknown project" };
	const key = path.resolve(projectPath as string);
	running.get(key)?.kill("SIGTERM");
	const backend = backendPath();
	const pythonExe = await requirePythonPath();
	const child = spawn(
		pythonExe,
		[path.resolve(backend, "runners", "build_compare_runner.py")],
		{ cwd: backend, env: pythonStaticRunnerEnv(backend) },
	);
	running.set(key, child);

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
		const finish = (answer: IPCResult<BuildComparison>) => {
			clearTimeout(timer);
			if (running.get(key) === child) running.delete(key);
			resolve(answer);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		child.on("error", (err) => {
			finish({ success: false, error: `Failed to start the comparison: ${err.message}` });
		});
		child.on("close", (code) => {
			const { result, error } = parseBuildCompareOutput(stdout);
			const comparison = code === 0 ? toBuildComparison(result) : null;
			if (comparison) {
				finish({ success: true, data: comparison });
				return;
			}
			finish({
				success: false,
				error:
					error ??
					(stderr.trim().split("\n").pop() ||
						`The comparison exited with code ${code}`),
			});
		});
		child.stdin?.on("error", () => {
			/* the runner exiting early is reported by "close" */
		});
		child.stdin?.end(payload);
	});
}
