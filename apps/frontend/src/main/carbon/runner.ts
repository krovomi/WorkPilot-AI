/**
 * One run of `runners/carbon_profiler_runner.py` (#365): the arguments are
 * built here from checked values, the process runs without a shell (S4), and
 * its result line is returned.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const EVENT_PREFIX = "CARBON_EVENT:";
const RESULT_PREFIX = "CARBON_RESULT:";
const ERROR_PREFIX = "CARBON_ERROR:";

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const FORMATS = ["json", "csv", "md"] as const;

export interface RunHandle {
	result: Promise<unknown>;
	child: ChildProcess;
}

export async function runCarbon(
	projectRoot: string,
	args: string[],
	onEvent?: (payload: unknown) => void,
): Promise<RunHandle> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "carbon_profiler_runner.py");
	const child = spawn(await requirePythonPath(), [runnerPath, "--project-path", projectRoot, ...args], {
		cwd: backendPath,
		env: await pythonRunnerEnv(backendPath),
	} as Parameters<typeof spawn>[2]);

	let buffer = "";
	let result: unknown = null;
	let errorMessage: string | null = null;
	const readLine = (line: string) => {
		if (line.startsWith(EVENT_PREFIX)) {
			try {
				onEvent?.(JSON.parse(line.slice(EVENT_PREFIX.length)));
			} catch {
				// a broken progress line is not worth failing the run
			}
		} else if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length));
			} catch (err) {
				console.error("[CarbonProfiler] Bad result line:", err);
			}
		} else if (line.startsWith(ERROR_PREFIX)) {
			errorMessage = line.slice(ERROR_PREFIX.length);
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
		console.error("[CarbonProfiler] stderr:", chunk.toString());
	});
	const done = new Promise<unknown>((resolve, reject) => {
		child.on("close", (code) => {
			if (code === 0 && result) resolve(result);
			else reject(new Error(errorMessage ?? `carbon profiler runner exited with code ${code}`));
		});
		child.on("error", (err) => reject(new Error(`Failed to start the carbon profiler runner: ${err.message}`)));
	});
	return { result: done, child };
}
