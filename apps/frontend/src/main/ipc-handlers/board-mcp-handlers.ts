/**
 * IPC of the "Use from other apps" project section: which AI apps already
 * start this project's `workpilot-board` MCP server, and register it with one.
 *
 * The renderer names a project and a client from a closed list; the command,
 * the files and the `claude` executable are all found here
 * (`main/board-mcp/service.ts`).
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import {
	type BoardMcpClientStatus,
	type BoardMcpStatus,
	isBoardMcpClient,
} from "../../shared/types/board-mcp";
import { ConfigParseError } from "../board-mcp/clients";
import {
	applyBoardMcp,
	type BoardMcpContext,
	boardMcpStatus,
	buildEntry,
	type ClaudeRunner,
} from "../board-mcp/service";
import { getToolInfo } from "../cli-tool-manager";
import { getAugmentedEnv } from "../env-utils";
import { getEnvVar, isSecurePath, isWindows, requiresShell } from "../platform";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { pythonEnvManager } from "../python-env-manager";

const CLAUDE_TIMEOUT_MS = 20_000;

function backendDir(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/**
 * The `claude` CLI, when it can be run without a shell: a `.cmd` launcher
 * (npm on Windows) only runs through cmd.exe, and the JSON argument would be
 * re-parsed by it. Then the person pastes the command instead.
 */
function claudeRunner(): ClaudeRunner | null {
	const info = getToolInfo("claude");
	const executable = info.found ? info.path : undefined;
	if (!executable || requiresShell(executable) || !isSecurePath(executable)) return null;
	return (args) =>
		new Promise((resolve) => {
			execFile(
				executable,
				args,
				{
					encoding: "utf-8",
					timeout: CLAUDE_TIMEOUT_MS,
					windowsHide: true,
					env: getAugmentedEnv(),
				},
				(error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
					resolve({ code, output: `${stdout}\n${stderr}` });
				},
			);
		});
}

/**
 * Where hermes-agent keeps its config: `HERMES_HOME`, else `%LOCALAPPDATA%\\hermes`
 * on Windows, else `~/.hermes` (the default `clientDefinitions` applies).
 */
function hermesHome(): string | undefined {
	const override = getEnvVar("HERMES_HOME");
	if (override) return override;
	if (!isWindows()) return undefined;
	const local = getEnvVar("LOCALAPPDATA");
	return path.join(local || path.join(os.homedir(), "AppData", "Local"), "hermes");
}

function context(projectId: unknown): BoardMcpContext | string {
	if (typeof projectId !== "string" || !projectId) return "projectId is required";
	const project = projectStore.getProject(projectId);
	if (!project) return "Project not found";
	if (project.remote) return "server_project";
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath) return "python_not_ready";
	return {
		dirs: {
			home: os.homedir(),
			appData: app.getPath("appData"),
			codexHome: getEnvVar("CODEX_HOME"),
			xdgConfig: getEnvVar("XDG_CONFIG_HOME"),
			hermesHome: hermesHome(),
		},
		entry: buildEntry(parsePythonCommand(pythonPath), backendDir(), project.path),
		projectName: project.name,
		claude: claudeRunner(),
	};
}

function failure(error: unknown): { success: false; error: string } {
	if (error instanceof ConfigParseError) return { success: false, error: "config_unreadable" };
	return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerBoardMcpHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.BOARD_MCP_STATUS,
		async (_, projectId: unknown): Promise<IPCResult<BoardMcpStatus>> => {
			const ctx = context(projectId);
			if (typeof ctx === "string") return { success: false, error: ctx };
			try {
				return { success: true, data: boardMcpStatus(ctx) };
			} catch (error) {
				return failure(error);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.BOARD_MCP_APPLY,
		async (
			_,
			projectId: unknown,
			clientId: unknown,
			add: unknown,
		): Promise<IPCResult<BoardMcpClientStatus>> => {
			if (!isBoardMcpClient(clientId)) return { success: false, error: "unknown client" };
			const ctx = context(projectId);
			if (typeof ctx === "string") return { success: false, error: ctx };
			try {
				return { success: true, data: await applyBoardMcp(ctx, clientId, add !== false) };
			} catch (error) {
				return failure(error);
			}
		},
	);
}
