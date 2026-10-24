/**
 * Agent Debugger IPC Handlers
 *
 * Provider-agnostic: the debugger state lives in the Python runner's
 * DebuggerRegistry (process-memory). The UI can attach, list/add/remove
 * breakpoints, list paused frames, and resume. Each IPC call spawns
 * agent_debugger_runner.py as a one-shot. A future iteration may keep a
 * long-running debugger daemon; the MVP is sufficient to wire the UI.
 *
 * Channels:
 *   agentDebugger:attach        → { sessionId }
 *   agentDebugger:detach        → { sessionId }
 *   agentDebugger:listBreakpoints → { sessionId } → { breakpoints }
 *   agentDebugger:setBreakpoint → { sessionId, breakpoint }
 *   agentDebugger:removeBreakpoint → { sessionId, id }
 *   agentDebugger:listFrames    → { sessionId } → { frames }
 *   agentDebugger:resume        → { sessionId, frameId, action, toolInput?, reason? }
 *   agentDebugger:listSessions  → {} → { sessions }
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { pythonEnvManager } from "../python-env-manager.js";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

interface RunnerArgs {
	action: string;
	sessionId: string;
	payload?: Record<string, unknown>;
}

function runRunner(req: RunnerArgs): Promise<unknown> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(
		backendPath,
		"runners",
		"agent_debugger_runner.py",
	);
	const pythonExe = pythonEnvManager.getPythonPath();
	if (!pythonExe) return Promise.reject(new Error("Python env not ready"));

	const args = [
		runnerPath,
		"--action",
		req.action,
		"--session-id",
		req.sessionId,
		"--payload",
		JSON.stringify(req.payload ?? {}),
	];

	return new Promise((resolve, reject) => {
		const child = spawn(pythonExe, args, {
			cwd: backendPath,
			env: { ...process.env, PYTHONPATH: backendPath },
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
				if (code !== 0) {
					reject(new Error(`runner exit ${code}: ${stderr}`));
					return;
				}
				resolve(parsed);
			} catch (err) {
				reject(
					new Error(
						`Failed to parse debugger runner output: ${(err as Error).message}`,
					),
				);
			}
		});
	});
}

export function registerAgentDebuggerHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_ATTACH,
		async (_e, { sessionId }: { sessionId: string }) =>
			runRunner({ action: "attach", sessionId }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_DETACH,
		async (_e, { sessionId }: { sessionId: string }) =>
			runRunner({ action: "detach", sessionId }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_LIST_BREAKPOINTS,
		async (_e, { sessionId }: { sessionId: string }) =>
			runRunner({ action: "list_bp", sessionId }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_SET_BREAKPOINT,
		async (
			_e,
			{
				sessionId,
				breakpoint,
			}: { sessionId: string; breakpoint: Record<string, unknown> },
		) => runRunner({ action: "add_bp", sessionId, payload: breakpoint }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_REMOVE_BREAKPOINT,
		async (_e, { sessionId, id }: { sessionId: string; id: string }) =>
			runRunner({ action: "remove_bp", sessionId, payload: { id } }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_LIST_FRAMES,
		async (_e, { sessionId }: { sessionId: string }) =>
			runRunner({ action: "list_frames", sessionId }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_GET_STATE,
		async (_e, { sessionId }: { sessionId: string }) =>
			runRunner({ action: "get_state", sessionId }),
	);
	ipcMain.handle(IPC_CHANNELS.AGENT_DEBUGGER_LIST_SESSIONS, async () =>
		runRunner({ action: "list_sessions", sessionId: "" }),
	);
	ipcMain.handle(
		IPC_CHANNELS.AGENT_DEBUGGER_RESUME,
		async (
			_e,
			payload: {
				sessionId: string;
				frameId: string;
				action: "continue" | "skip" | "modify";
				toolInput?: Record<string, unknown>;
				reason?: string;
			},
		) =>
			runRunner({
				action: "resume",
				sessionId: payload.sessionId,
				payload: {
					frame_id: payload.frameId,
					action: payload.action,
					tool_input: payload.toolInput,
					reason: payload.reason,
				},
			}),
	);
}
