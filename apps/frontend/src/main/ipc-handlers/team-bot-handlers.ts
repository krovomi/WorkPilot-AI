/**
 * Team Bot IPC Handlers — Slack / Microsoft Teams notifications.
 *
 * Channels:
 *   teamBot:getConfig  → TeamBotConfig, webhook URL masked
 *   teamBot:saveConfig → TeamBotConfig (masked) after storing it
 *   teamBot:send       → { payload } → { ok }
 *   teamBot:test       → { ok }
 *
 * The configuration, webhook URL included, is the main process's own
 * (team-bot-config.ts): the renderer never names the URL a send goes to, and
 * the runner reads its input from stdin, not from a command line every local
 * process can list (F175). Provider-agnostic: no LLM calls, only webhook POSTs.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	maskedTeamBotConfig,
	readTeamBotConfig,
	saveTeamBotConfig,
} from "../team-bot-config";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const NO_WEBHOOK = "No webhook URL is configured";

async function runRunner(
	action: "send" | "test",
	payload: Record<string, unknown>,
): Promise<unknown> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(
		backendPath,
		"runners",
		"team_bot_runner.py",
	);
	const pythonExe = await requirePythonPath();

	const args = [runnerPath, "--action", action, "--payload", "-"];

	const env = await pythonRunnerEnv(backendPath);
	return new Promise((resolve, reject) => {
		const child = spawn(pythonExe, args, {
			cwd: backendPath,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		} as Parameters<typeof spawn>[2]);

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const last = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
			try {
				const parsed = JSON.parse(last) as Record<string, unknown>;
				if (parsed.error) {
					reject(new Error(String(parsed.error)));
					return;
				}
				if (code !== 0 && code !== 2) {
					reject(new Error(`runner exit ${code}: ${stderr}`));
					return;
				}
				resolve(parsed);
			} catch (err) {
				reject(
					new Error(
						`Failed to parse team-bot runner output: ${(err as Error).message}`,
					),
				);
			}
		});
		child.stdin?.end(JSON.stringify(payload));
	});
}

/** The stored configuration, ready for the runner, or an error without one. */
function configForRunner(): Record<string, unknown> {
	const config = readTeamBotConfig();
	if (!config.webhook_url) throw new Error(NO_WEBHOOK);
	return { ...config };
}

function notification(value: unknown): Record<string, unknown> {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const payload = record.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Invalid notification");
	}
	const { title } = payload as Record<string, unknown>;
	if (typeof title !== "string" || !title) throw new Error("Invalid notification");
	return payload as Record<string, unknown>;
}

export function registerTeamBotHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TEAM_BOT_GET_CONFIG, async () =>
		maskedTeamBotConfig(),
	);
	ipcMain.handle(IPC_CHANNELS.TEAM_BOT_SAVE_CONFIG, async (_e, config: unknown) =>
		saveTeamBotConfig(config),
	);
	ipcMain.handle(IPC_CHANNELS.TEAM_BOT_SEND, async (_e, request: unknown) =>
		runRunner("send", { config: configForRunner(), payload: notification(request) }),
	);
	ipcMain.handle(IPC_CHANNELS.TEAM_BOT_TEST, async () =>
		runRunner("test", { config: configForRunner() }),
	);
}
