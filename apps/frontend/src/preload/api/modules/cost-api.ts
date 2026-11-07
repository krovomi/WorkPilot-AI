/**
 * Cost Estimator Preload API
 * Exposes cost summary and budget IPC calls to the renderer process.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	CostSummary,
	DashboardSnapshot,
	IPCResult,
	WorkspaceSession,
} from "../../../shared/types";

export type { CostSummary, DashboardSnapshot };

export interface BudgetInfo {
	monthly_budget: number;
	spent_this_month: number;
	remaining: number;
	utilization_pct: number;
	alerts: string[];
	forecast_end_of_month: number;
}

export interface ContextUsage {
	provider: string;
	model: string;
	/** input_tokens de la dernière requête = remplissage du contexte */
	contextTokens: number;
	outputTokens: number;
	timestamp: string;
}

export interface CostAPI {
	getCostSummary(
		projectPath: string,
	): Promise<{ success: boolean; summary?: CostSummary; error?: string }>;
	getContextUsage(
		projectPath: string,
		provider: string,
	): Promise<{
		success: boolean;
		contextUsage?: ContextUsage | null;
		error?: string;
	}>;
	getCostBudget(
		projectPath: string,
	): Promise<{ success: boolean; budget?: BudgetInfo; error?: string }>;
	setCostBudget(
		projectPath: string,
		limit: number,
		period?: string,
	): Promise<{ success: boolean; error?: string }>;
	getDashboardSnapshot(projectPath: string): Promise<{
		success: boolean;
		snapshot?: DashboardSnapshot;
		error?: string;
	}>;
	onCostsUpdated(callback: (projectPath: string) => void): () => void;
	onDashboardSnapshotUpdated(
		callback: (projectPath: string) => void,
	): () => void;
	/** A server project's views, computed by the server: by id, never a path. */
	getServerCostSummary(projectId: string): Promise<IPCResult<CostSummary>>;
	getServerDashboardSnapshot(
		projectId: string,
	): Promise<IPCResult<DashboardSnapshot>>;
	getServerSessions(projectId: string): Promise<IPCResult<WorkspaceSession[]>>;
}

export const createCostAPI = (): CostAPI => ({
	getCostSummary: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_SUMMARY, projectPath),

	getContextUsage: (projectPath: string, provider: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_CONTEXT_USAGE, projectPath, provider),

	getCostBudget: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_BUDGET, projectPath),

	setCostBudget: (projectPath: string, limit: number, period = "monthly") =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_SET_BUDGET, projectPath, limit, period),

	getDashboardSnapshot: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET_SNAPSHOT, projectPath),

	getServerCostSummary: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_COSTS, projectId),

	getServerDashboardSnapshot: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_DASHBOARD, projectId),

	getServerSessions: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_SESSIONS, projectId),

	onCostsUpdated: (callback: (projectPath: string) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, projectPath: string) =>
			callback(projectPath);
		ipcRenderer.on(IPC_CHANNELS.COSTS_DATA_UPDATED, handler);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.COSTS_DATA_UPDATED, handler);
	},

	onDashboardSnapshotUpdated: (callback: (projectPath: string) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, projectPath: string) =>
			callback(projectPath);
		ipcRenderer.on(IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED, handler);
		return () =>
			ipcRenderer.removeListener(
				IPC_CHANNELS.DASHBOARD_SNAPSHOT_UPDATED,
				handler,
			);
	},
});
