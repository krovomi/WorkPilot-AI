/**
 * Onboarding Agent IPC Handlers
 *
 * Spawns the Python onboarding agent runner which analyses a project and
 * returns an onboarding guide.
 *
 * Channels:
 *   invoke "onboardingAgent:run"     → { projectPath }
 *   invoke "onboardingAgent:cancel"  → void
 *   invoke "onboardingAgent:status"  → { projectPath }: is the last tour stale?
 *   invoke "onboardingAgent:narrate" → { projectPath, language }: chapters in prose
 *   invoke "onboardingAgent:export"  → { format, document }: save dialog, then file
 *
 * Every project path is one the user added (`resolveKnownProject`, S6).
 *
 * Renderer events:
 *   onboarding-event
 *   onboarding-result
 *   onboarding-error
 */

import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { requirePythonPath } from "../utils/ensure-python";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { OnboardingExportOutcome } from "../../shared/types/onboarding-export";
import { showSaveDialog } from "../electron-utils";
import {
	exportFileName,
	readExportRequest,
	toHtml,
	toMarkdown,
} from "../onboarding-agent/export-document";
import { resolveKnownProject } from "../security/renderer-path";
import { pythonRunnerEnv } from "../utils/python-runner-env";

interface RunRequest {
	projectPath: string;
}

const EVENT_PREFIX = "ONBOARDING_EVENT:";
const RESULT_PREFIX = "ONBOARDING_RESULT:";
const ERROR_PREFIX = "ONBOARDING_ERROR:";
const STATUS_PREFIX = "ONBOARDING_STATUS:";
const NARRATION_PREFIX = "ONBOARDING_NARRATION:";
const NARRATE_LANGUAGES = new Set(["en", "fr"]);
const ONE_SHOT_TIMEOUT_MS = 10 * 60_000;

function backendDir(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** Runs the runner once with `args` and returns the JSON of its `prefix` line. */
async function runOnce<T>(projectPath: string, args: string[], prefix: string): Promise<T> {
	const backendPath = backendDir();
	const runnerPath = path.resolve(backendPath, "runners", "onboarding_agent_runner.py");
	const python = await requirePythonPath();
	const env = await pythonRunnerEnv(backendPath);
	return new Promise<T>((resolve, reject) => {
		const child = spawn(python, [runnerPath, "--project-path", projectPath, ...args], {
			cwd: backendPath,
			env,
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), ONE_SHOT_TIMEOUT_MS);
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => console.error("[Onboarding] stderr:", chunk.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const lines = out.split("\n").map((line) => line.trim());
			const result = lines.find((line) => line.startsWith(prefix));
			const error = lines.find((line) => line.startsWith(ERROR_PREFIX));
			if (code !== 0 || !result) {
				reject(new Error(error?.slice(ERROR_PREFIX.length) || `onboarding runner exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(result.slice(prefix.length)) as T);
			} catch (err) {
				reject(err);
			}
		});
	});
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

export function registerOnboardingAgentHandlers(): void {
	let currentProcess: ChildProcess | null = null;

	const killExisting = (): void => {
		if (currentProcess) {
			currentProcess.kill("SIGTERM");
			currentProcess = null;
		}
	};

	ipcMain.handle(
		IPC_CHANNELS.ONBOARDING_AGENT_RUN,
		async (_event, request: RunRequest) => {
			killExisting();

			const projectPath = resolveKnownProject(request?.projectPath);
			if (!projectPath) {
				const message = "projectPath is not a project of this app";
				broadcast(IPC_CHANNELS.ONBOARDING_ERROR, message);
				throw new Error(message);
			}

			const backendPath = backendDir();
			const runnerPath = path.resolve(
				backendPath,
				"runners",
				"onboarding_agent_runner.py",
			);

			const pythonExe = await requirePythonPath();

			const child = spawn(
				pythonExe,
				[runnerPath, "--project-path", projectPath],
				{
					cwd: backendPath,
					env: await pythonRunnerEnv(backendPath),
				} as Parameters<typeof spawn>[2],
			);
			currentProcess = child;

			let buffer = "";
			let result: unknown = null;
			let errorMessage: string | null = null;

			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				let newlineIdx = buffer.indexOf("\n");
				while (newlineIdx >= 0) {
					const line = buffer.slice(0, newlineIdx).trim();
					buffer = buffer.slice(newlineIdx + 1);
					newlineIdx = buffer.indexOf("\n");
					if (!line) continue;

					if (line.startsWith(EVENT_PREFIX)) {
						try {
							const payload = JSON.parse(line.slice(EVENT_PREFIX.length));
							broadcast(IPC_CHANNELS.ONBOARDING_EVENT, payload);
						} catch (err) {
							console.error("[Onboarding] Bad event line:", err);
						}
					} else if (line.startsWith(RESULT_PREFIX)) {
						try {
							result = JSON.parse(line.slice(RESULT_PREFIX.length));
						} catch (err) {
							console.error("[Onboarding] Bad result line:", err);
						}
					} else if (line.startsWith(ERROR_PREFIX)) {
						errorMessage = line.slice(ERROR_PREFIX.length);
					}
				}
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				console.error("[Onboarding] stderr:", chunk.toString());
			});

			return new Promise((resolve, reject) => {
				child.on("close", (code) => {
					currentProcess = null;
					if (code === 0 && result) {
						broadcast(IPC_CHANNELS.ONBOARDING_RESULT, result);
						resolve(result);
					} else {
						const message =
							errorMessage ?? `onboarding runner exited with code ${code}`;
						broadcast(IPC_CHANNELS.ONBOARDING_ERROR, message);
						reject(new Error(message));
					}
				});

				child.on("error", (err) => {
					currentProcess = null;
					const message = `Failed to start onboarding runner: ${err.message}`;
					broadcast(IPC_CHANNELS.ONBOARDING_ERROR, message);
					reject(new Error(message));
				});
			});
		},
	);

	ipcMain.handle(IPC_CHANNELS.ONBOARDING_AGENT_CANCEL, () => {
		killExisting();
		return true;
	});

	ipcMain.handle(IPC_CHANNELS.ONBOARDING_AGENT_STATUS, async (_event, request: RunRequest) => {
		const projectPath = resolveKnownProject(request?.projectPath);
		if (!projectPath) throw new Error("projectPath is not a project of this app");
		return runOnce(projectPath, ["--status"], STATUS_PREFIX);
	});

	ipcMain.handle(IPC_CHANNELS.ONBOARDING_AGENT_NARRATE, async (_event, request: unknown) => {
		const r = (request ?? {}) as Record<string, unknown>;
		const projectPath = resolveKnownProject(r.projectPath);
		if (!projectPath) throw new Error("projectPath is not a project of this app");
		const language = typeof r.language === "string" ? r.language.slice(0, 2).toLowerCase() : "";
		if (!NARRATE_LANGUAGES.has(language)) throw new Error("Unsupported language");
		return runOnce(projectPath, ["--narrate", "--language", language], NARRATION_PREFIX);
	});

	ipcMain.handle(
		IPC_CHANNELS.ONBOARDING_AGENT_EXPORT,
		async (_event, raw: unknown): Promise<OnboardingExportOutcome> => {
			const request = readExportRequest(raw);
			if (!request) throw new Error("Invalid export request");
			const html = request.format === "html";
			const choice = await showSaveDialog({
				defaultPath: path.join(app.getPath("documents"), exportFileName(request.document.title, request.format)),
				filters: [html ? { name: "HTML", extensions: ["html"] } : { name: "Markdown", extensions: ["md"] }],
			});
			if (choice.canceled || !choice.filePath) return { saved: false };
			// The path comes from the dialog the user just answered, not from the renderer.
			await writeFile(choice.filePath, html ? toHtml(request.document) : toMarkdown(request.document), "utf-8");
			return { saved: true, path: choice.filePath };
		},
	);
}
