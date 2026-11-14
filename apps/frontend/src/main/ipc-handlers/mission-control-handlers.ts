/**
 * Mission Control IPC. The renderer used to fetch the backend itself; a
 * packaged app's page has the origin `null`, which the backend's CORS list
 * refuses, and starting an agent never called a model at all. Every call now
 * goes through here: the state is proxied to the local backend
 * (`backendFetch`), and an agent's model call runs in this process
 * (`mission-control/mission-control-runs.ts`).
 *
 * The renderer names agents by id and a project by id; everything is checked
 * here before it reaches the backend.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type {
	MissionControlAgent,
	MissionControlSession,
	MissionControlState,
} from "../../shared/types/mission-control";
import {
	isAgentId,
	MAX_TASK_CHARS,
	type MissionControlDeps,
	startMissionControlAgent,
	stopAllMissionControlRuns,
	stopMissionControlRun,
} from "../mission-control/mission-control-runs";
import { runOneShotLLM } from "../oneshot-llm";
import { projectStore } from "../project-store";
import { backendFetch } from "./_backend-fetch";

const BASE = "/api/mission-control";
const MAX_NAME_CHARS = 200;
const MAX_FIELD_CHARS = 200;

const deps: MissionControlDeps = { backendFetch, runOneShotLLM };

function text(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length <= max ? trimmed : null;
}

async function call<T>(
	path: string,
	init?: RequestInit,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
	const result = await backendFetch<T>(`${BASE}${path}`, init);
	if (!result.success) return { ok: false, error: result.error };
	return { ok: true, body: result as T };
}

function post(body: unknown): RequestInit {
	return { method: "POST", body: JSON.stringify(body) };
}

/** The checkout of a local project, for the providers that run in one. */
function projectDirFor(projectId: unknown): string | undefined {
	if (typeof projectId !== "string" || !projectId) return undefined;
	return projectStore.getProject(projectId)?.path || undefined;
}

export function registerMissionControlHandlers(
	runDeps: MissionControlDeps = deps,
): void {
	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_GET_STATE,
		async (): Promise<IPCResult<MissionControlState>> => {
			const r = await call<{ state: MissionControlState }>("/state");
			return r.ok ? { success: true, data: r.body.state } : { success: false, error: r.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_START_SESSION,
		async (): Promise<IPCResult<MissionControlSession>> => {
			const r = await call<{ session: MissionControlSession }>(
				"/session/start",
				post({ name: "Mission Control" }),
			);
			return r.ok ? { success: true, data: r.body.session } : { success: false, error: r.error };
		},
	);

	ipcMain.handle(IPC_CHANNELS.MISSION_CONTROL_STOP_SESSION, async (): Promise<IPCResult> => {
		stopAllMissionControlRuns();
		const r = await call("/session/stop", post({}));
		return r.ok ? { success: true } : { success: false, error: r.error };
	});

	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_CREATE_AGENT,
		async (_event, agent: unknown): Promise<IPCResult<MissionControlAgent>> => {
			const a = (agent ?? {}) as Record<string, unknown>;
			const name = text(a.name, MAX_NAME_CHARS);
			const role = text(a.role, MAX_FIELD_CHARS);
			const provider = text(a.provider, MAX_FIELD_CHARS);
			const model = text(a.model ?? "", MAX_FIELD_CHARS);
			const modelLabel = text(a.modelLabel ?? "", MAX_FIELD_CHARS);
			if (!name || role === null || !provider || model === null || modelLabel === null) {
				return { success: false, error: "Invalid agent" };
			}
			const r = await call<{ agent: MissionControlAgent }>(
				"/agents",
				post({ name, role, provider, model, model_label: modelLabel }),
			);
			return r.ok ? { success: true, data: r.body.agent } : { success: false, error: r.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_REMOVE_AGENT,
		async (_event, agentId: unknown): Promise<IPCResult> => {
			if (!isAgentId(agentId)) return { success: false, error: "Invalid agent" };
			stopMissionControlRun(agentId);
			const r = await call(`/agents/${agentId}`, { method: "DELETE" });
			return r.ok ? { success: true } : { success: false, error: r.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_START_AGENT,
		async (_event, request: unknown): Promise<IPCResult> => {
			const req = (request ?? {}) as Record<string, unknown>;
			if (!isAgentId(req.agentId)) return { success: false, error: "Invalid agent" };
			const task = text(req.task ?? "", MAX_TASK_CHARS);
			if (task === null) return { success: false, error: "Task too long" };
			const result = await startMissionControlAgent(
				runDeps,
				req.agentId,
				task,
				projectDirFor(req.projectId),
			);
			return result.success ? { success: true } : { success: false, error: result.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MISSION_CONTROL_STOP_AGENT,
		async (_event, agentId: unknown): Promise<IPCResult> => {
			if (!isAgentId(agentId)) return { success: false, error: "Invalid agent" };
			stopMissionControlRun(agentId);
			const r = await call(`/agents/${agentId}/stop`, post({}));
			return r.ok ? { success: true } : { success: false, error: r.error };
		},
	);
}
