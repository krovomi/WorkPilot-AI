/**
 * Cost Estimator Preload API
 * Exposes cost summary and budget IPC calls to the renderer process.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { BuildComparison } from "../../../shared/types/build-compare";
import type { CostBudgetConfig, CostBudgetStatus } from "../../../shared/types/cost-budget";
import type {
	CostSummary,
	DashboardSnapshot,
	IPCResult,
	WorkspaceSession,
} from "../../../shared/types";

export type { CostSummary, DashboardSnapshot };

export type { CostBudgetConfig, CostBudgetStatus } from "../../../shared/types/cost-budget";

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
	): Promise<{ success: boolean; budget?: CostBudgetStatus; error?: string }>;
	setCostBudget(
		projectPath: string,
		budget: CostBudgetConfig,
	): Promise<{ success: boolean; budget?: CostBudgetConfig; error?: string }>;
	/** One task's own limit in USD; 0 clears it. */
	setTaskBudget(
		projectId: string,
		taskId: string,
		amountUsd: number,
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
	/** "How you compare": a project of this computer, by its folder. */
	getBuildComparison(projectPath: string): Promise<IPCResult<BuildComparison>>;
	/** "How you compare" for a server project, by id: medians only. */
	getServerBuildComparison(
		projectId: string,
	): Promise<IPCResult<BuildComparison>>;
}

export const createCostAPI = (): CostAPI => ({
	getCostSummary: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_SUMMARY, projectPath),

	getContextUsage: (projectPath: string, provider: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_CONTEXT_USAGE, projectPath, provider),

	getCostBudget: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_GET_BUDGET, projectPath),

	setCostBudget: (projectPath: string, budget: CostBudgetConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_SET_BUDGET, projectPath, budget),

	setTaskBudget: (projectId: string, taskId: string, amountUsd: number) =>
		ipcRenderer.invoke(IPC_CHANNELS.COSTS_SET_TASK_BUDGET, projectId, taskId, amountUsd),

	getDashboardSnapshot: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET_SNAPSHOT, projectPath),

	getServerCostSummary: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_COSTS, projectId),

	getServerDashboardSnapshot: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_DASHBOARD, projectId),

	getServerSessions: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_SESSIONS, projectId),

	getBuildComparison: (projectPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_COMPARE, projectPath),

	getServerBuildComparison: (projectId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SERVER_WORKSPACE_COMPARE, projectId),

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
