/**
 * Browser Agent IPC Handlers
 *
 * Feature #20 — Handles communication between the renderer
 * and the backend browser agent system.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { parsePythonCommand } from "../python-detector";
import {
	getConfiguredPythonPath,
	pythonEnvManager,
} from "../python-env-manager";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Register all browser agent IPC handlers.
 */
export function registerBrowserAgentHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// ── Dashboard data ────────────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_GET_DASHBOARD,
		async (_, projectPath: string) => {
			try {
				const result = await runBrowserAgentCommand(projectPath, [
					"dashboard",
				]);
				// The runner already emits { success, data }, so return it
				// as-is rather than re-wrapping (which would nest data.data).
				const parsed = JSON.parse(result);
				return { success: parsed.success, data: parsed.data };
			} catch (_error) {
				return { success: true, data: getEmptyDashboard() };
			}
		},
	);

	// ── Screenshot capture ────────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_CAPTURE_SCREENSHOT,
		async (_, projectPath: string, name: string, url: string) => {
			try {
				const mainWindow = getMainWindow();
				if (mainWindow) {
					mainWindow.webContents.send(IPC_CHANNELS.BROWSER_AGENT_PROGRESS, {
						step: "capturing",
						message: `Capturing screenshot of ${url}...`,
					});
				}

				const result = await runBrowserAgentCommand(projectPath, [
					"screenshot",
					"--url",
					url,
					"--name",
					name,
				]);
				const data = JSON.parse(result);

				if (mainWindow) {
					mainWindow.webContents.send(
						IPC_CHANNELS.BROWSER_AGENT_SCREENSHOT_READY,
						data,
					);
				}

				return data;
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// ── Screenshot image reading ──────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
		async (_, screenshotPath: string) => {
			try {
				const buffer = fs.readFileSync(screenshotPath);
				const base64 = buffer.toString("base64");
				return { success: true, data: { base64, mimeType: "image/png" } };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// ── Navigation ────────────────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_NAVIGATE,
		async (_, projectPath: string, url: string) => {
			try {
				const result = await runBrowserAgentCommand(projectPath, [
					"screenshot",
					"--url",
					url,
					"--name",
					"navigation_preview",
				]);
				return JSON.parse(result);
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// ── Baseline management ───────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_SET_BASELINE,
		async (_, projectPath: string, name: string, screenshotPath?: string) => {
			try {
				const args = ["baseline", "set", "--name", name];
				if (screenshotPath) {
					args.push("--screenshot", screenshotPath);
				}
				const result = await runBrowserAgentCommand(projectPath, args);
				return JSON.parse(result);
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_LIST_BASELINES,
		async (_, projectPath: string) => {
			try {
				const result = await runBrowserAgentCommand(projectPath, [
					"baseline",
					"list",
				]);
				return JSON.parse(result);
			} catch (_error) {
				return { success: true, data: [] };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_DELETE_BASELINE,
		async (_, projectPath: string, name: string) => {
			try {
				const result = await runBrowserAgentCommand(projectPath, [
					"baseline",
					"delete",
					"--name",
					name,
				]);
				return JSON.parse(result);
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// ── Visual comparison ─────────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_COMPARE,
		async (_, projectPath: string, name: string, url?: string) => {
			try {
				const mainWindow = getMainWindow();
				if (mainWindow) {
					mainWindow.webContents.send(IPC_CHANNELS.BROWSER_AGENT_PROGRESS, {
						step: "comparing",
						message: `Comparing '${name}' against baseline...`,
					});
				}

				const args = ["compare", "--name", name];
				if (url) {
					args.push("--url", url);
				}
				const result = await runBrowserAgentCommand(projectPath, args);
				return JSON.parse(result);
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	// ── Test execution ────────────────────────────────────────

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_RUN_TESTS,
		async (_, projectPath: string) => {
			try {
				const mainWindow = getMainWindow();
				if (mainWindow) {
					mainWindow.webContents.send(IPC_CHANNELS.BROWSER_AGENT_PROGRESS, {
						step: "testing",
						message: "Running E2E tests...",
					});
				}

				const result = await runBrowserAgentCommand(
					projectPath,
					["tests"],
					300000,
				);
				const data = JSON.parse(result);

				if (mainWindow) {
					mainWindow.webContents.send(
						IPC_CHANNELS.BROWSER_AGENT_TEST_COMPLETE,
						data,
					);
				}

				return data;
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);
}

// ── Helpers ─────────────────────────────────────────────────

function getEmptyDashboard() {
	return {
		stats: {
			totalTests: 0,
			passRate: 0,
			screenshotsCaptured: 0,
			regressionsDetected: 0,
		},
		screenshots: [],
		baselines: [],
		comparisons: [],
		recentTestRun: null,
	};
}

function runBrowserAgentCommand(
	projectPath: string,
	args: string[],
	timeout = 120000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const runnerPath = path.join(
			__dirname,
			"..",
			"..",
			"..",
			"backend",
			"runners",
			"browser_agent_runner.py",
		);
		// Use the app's configured Python (the project venv, which is where
		// backend deps like playwright are installed) instead of a bare
		// "python" that would resolve to whatever is first on the runtime PATH.
		const pythonPath = getConfiguredPythonPath();
		const [cmd, pythonBaseArgs] = parsePythonCommand(pythonPath);
		// getPythonEnv() already sets PYTHONIOENCODING=utf-8 + PYTHONPATH so the
		// venv's site-packages resolve and emoji don't crash on a cp1252 pipe.
		const env = pythonEnvManager.getPythonEnv();

		const proc = spawn(
			cmd,
			[
				...pythonBaseArgs,
				runnerPath,
				"--project",
				projectPath,
				"--json",
				...args,
			],
			{
				cwd: projectPath,
				stdio: ["ignore", "pipe", "pipe"],
				timeout,
				env,
			},
		);

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(stdout);
			} else if (stdout.trim()) {
				// The runner emits structured errors ({ success:false, error })
				// on stdout before exiting non-zero. Surface that so callers
				// see the real message instead of an empty "exited with code 1".
				resolve(stdout);
			} else {
				reject(
					new Error(`Browser agent runner exited with code ${code}: ${stderr}`),
				);
			}
		});

		proc.on("error", (err: Error) => {
			reject(err);
		});
	});
}
