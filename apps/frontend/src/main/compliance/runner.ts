/**
 * One run of `runners/compliance_runner.py` (#357): the arguments are built
 * here from checked values (never a string the renderer wrote into a command),
 * the process runs without a shell (S4), and its result line is returned.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const EVENT_PREFIX = "COMPLIANCE_EVENT:";
const RESULT_PREFIX = "COMPLIANCE_RESULT:";
const ERROR_PREFIX = "COMPLIANCE_ERROR:";

export { FRAMEWORK_ID } from "./monthly";
export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const REPORT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}-\d{4}-\d{2}\.json$/;

export interface RunHandle {
	result: Promise<unknown>;
	child: ChildProcess;
}

export async function runCompliance(
	projectRoot: string,
	args: string[],
	onEvent?: (payload: unknown) => void,
): Promise<RunHandle> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "compliance_runner.py");
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
				console.error("[Compliance] Bad result line:", err);
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
		console.error("[Compliance] stderr:", chunk.toString());
	});
	const done = new Promise<unknown>((resolve, reject) => {
		child.on("close", (code) => {
			if (code === 0 && result) resolve(result);
			else reject(new Error(errorMessage ?? `compliance runner exited with code ${code}`));
		});
		child.on("error", (err) => reject(new Error(`Failed to start compliance runner: ${err.message}`)));
	});
	return { result: done, child };
}
