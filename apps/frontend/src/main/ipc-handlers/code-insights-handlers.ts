/**
 * Code insights IPC handler: the "Code review" and "Refactoring" views.
 *
 * Runs `runners/code_insights_runner.py` (static review of a patch, code
 * smells and refactoring proposals of a snippet, every stack) in the managed
 * Python. Both views used to fetch a relative `/api/...` URL from the
 * renderer, which never reached the backend in the desktop app.
 *
 * The text can be large, so the request goes to the runner on stdin, never
 * on its command line.
 *
 * Channel:
 *   invoke "codeInsights:run" → { action, text?, language? } → result
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { CodeInsightsRequest } from "../../shared/types/code-insights";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonStaticRunnerEnv } from "../utils/python-runner-env";

const ACTIONS = new Set(["review", "smells", "propose", "languages"]);
const LANGUAGE_ID = /^[a-z+#]{1,20}$/;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const RESULT_PREFIX = "CODE_INSIGHTS_RESULT:";
const ERROR_PREFIX = "CODE_INSIGHTS_ERROR:";

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** Revalidates the renderer's request; returns the JSON the runner reads. */
export function codeInsightsPayload(request: CodeInsightsRequest): string {
	const { action, text, language } = request ?? ({} as CodeInsightsRequest);
	if (!ACTIONS.has(action)) throw new Error(`Unknown code insights action: ${String(action)}`);
	const payload: CodeInsightsRequest = { action };
	if (action !== "languages") {
		if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
		if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
			throw new Error("Input exceeds 2 MB");
		}
		payload.text = text;
	}
	if (language !== undefined && language !== null && language !== "") {
		if (typeof language !== "string" || !LANGUAGE_ID.test(language)) {
			throw new Error("Invalid language id");
		}
		payload.language = language;
	}
	return JSON.stringify(payload);
}

/** The runner's result line, or its error, from its whole stdout. */
export function parseCodeInsightsOutput(stdout: string): { result?: unknown; error?: string } {
	let result: unknown;
	let error: string | undefined;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length));
			} catch (err) {
				error = `Unreadable code insights result: ${String(err)}`;
			}
		} else if (line.startsWith(ERROR_PREFIX)) {
			error = line.slice(ERROR_PREFIX.length);
		}
	}
	return { result, error };
}

export function registerCodeInsightsHandlers(): void {
	// One analysis per action at a time: a new click replaces the previous one.
	const running = new Map<string, ChildProcess>();

	ipcMain.handle(IPC_CHANNELS.CODE_INSIGHTS_RUN, async (_event, request: CodeInsightsRequest) => {
		const payload = codeInsightsPayload(request);
		const action = request.action;
		running.get(action)?.kill("SIGTERM");
		const backend = backendPath();
		const pythonExe = await requirePythonPath();
		const runner = path.resolve(backend, "runners", "code_insights_runner.py");
		const child = spawn(pythonExe, [runner], {
			cwd: backend,
			env: pythonStaticRunnerEnv(backend),
		} as Parameters<typeof spawn>[2]);
		running.set(action, child);

		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-2000);
			});
			const done = () => {
				if (running.get(action) === child) running.delete(action);
			};
			child.on("error", (err) => {
				done();
				reject(new Error(`Failed to start the code insights runner: ${err.message}`));
			});
			child.on("close", (code) => {
				done();
				const { result, error } = parseCodeInsightsOutput(stdout);
				if (code === 0 && result) resolve(result);
				else
					reject(
						new Error(
							error ??
								(stderr.trim().split("\n").pop() ||
									`code insights runner exited with code ${code}`),
						),
					);
			});
			child.stdin?.on("error", () => {
				/* the runner exiting early is reported by "close" */
			});
			child.stdin?.end(payload);
		});
	});
}
