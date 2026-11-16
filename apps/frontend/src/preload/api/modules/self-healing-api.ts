/**
 * Self-Healing API
 * Exposes the Self-Healing Codebase + Incident Responder functionality to the renderer.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	BisectProgressEvent,
	BisectRequestResult,
} from "../../../shared/types/self-healing";


export interface SelfHealingAPIObject {
	getDashboard(
		projectPath: string,
	): Promise<{ success: boolean; data?: unknown }>;
	getIncidents(
		projectPath: string,
		mode?: string,
	): Promise<{ success: boolean; data?: unknown[] }>;
	getOperations(
		projectPath: string,
	): Promise<{ success: boolean; data?: unknown[] }>;
	getFragility(
		projectPath: string,
	): Promise<{ success: boolean; data?: unknown[] }>;

	cicdEnable(
		projectPath: string,
	): Promise<{ success: boolean; error?: string }>;
	cicdDisable(
		projectPath: string,
	): Promise<{ success: boolean; error?: string }>;
	cicdConfig(
		projectPath: string,
		config: Record<string, unknown>,
	): Promise<{ success: boolean; config?: unknown; error?: string }>;

	productionConnect(
		projectPath: string,
		sourceConfig: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }>;
	productionDisconnect(
		projectPath: string,
		source: string,
	): Promise<{ success: boolean; error?: string }>;
	productionConfig(
		projectPath: string,
		config: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }>;

	proactiveScan(
		projectPath: string,
	): Promise<{ success: boolean; error?: string }>;
	proactiveConfig(
		projectPath: string,
		config: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }>;

	triggerFix(
		projectPath: string,
		incidentId: string,
	): Promise<{ success: boolean; error?: string }>;
	cancelOperation(
		projectPath: string,
		operationId: string,
	): Promise<{ success: boolean; error?: string }>;
	dismissIncident(
		projectPath: string,
		incidentId: string,
	): Promise<{ success: boolean; error?: string }>;
	retryIncident(
		projectPath: string,
		incidentId: string,
	): Promise<{ success: boolean; error?: string }>;

	/** First bad commit of a CI/CD incident; `goodSha` is a hex commit id. */
	bisectIncident(
		projectPath: string,
		incidentId: string,
		goodSha?: string,
	): Promise<BisectRequestResult>;

	onOperationProgress(callback: (data: unknown) => void): () => void;
	onOperationComplete(callback: (data: unknown) => void): () => void;
	onBisectProgress(callback: (data: BisectProgressEvent) => void): () => void;
}

export const createSelfHealingAPI = (): SelfHealingAPIObject => ({
	getDashboard: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_GET_DASHBOARD, projectPath),
	getIncidents: (projectPath, mode?) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_GET_INCIDENTS, projectPath, mode),
	getOperations: (projectPath) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_GET_OPERATIONS, projectPath),
	getFragility: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_GET_FRAGILITY, projectPath),

	cicdEnable: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_CICD_ENABLE, projectPath),
	cicdDisable: (projectPath) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_CICD_DISABLE, projectPath),
	cicdConfig: (projectPath, config) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_CICD_CONFIG, projectPath, config),

	productionConnect: (projectPath, sourceConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_PRODUCTION_CONNECT, projectPath, sourceConfig),
	productionDisconnect: (projectPath, source) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_PRODUCTION_DISCONNECT, projectPath, source),
	productionConfig: (projectPath, config) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_PRODUCTION_CONFIG, projectPath, config),

	proactiveScan: (projectPath) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_PROACTIVE_SCAN, projectPath),
	proactiveConfig: (projectPath, config) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_PROACTIVE_CONFIG, projectPath, config),

	triggerFix: (projectPath, incidentId) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_TRIGGER_FIX, projectPath, incidentId),
	cancelOperation: (projectPath, operationId) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_CANCEL_OPERATION, projectPath, operationId),
	dismissIncident: (projectPath, incidentId) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_DISMISS_INCIDENT, projectPath, incidentId),
	retryIncident: (projectPath, incidentId) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_RETRY_INCIDENT, projectPath, incidentId),

	bisectIncident: (projectPath, incidentId, goodSha) =>
		ipcRenderer.invoke(IPC_CHANNELS.SELF_HEALING_BISECT, projectPath, incidentId, goodSha),

	onBisectProgress: (callback) => {
		const handler = (_event: Electron.IpcRendererEvent, data: BisectProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS, handler);
	},
	onOperationProgress: (callback) => {
		const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.SELF_HEALING_OPERATION_PROGRESS, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.SELF_HEALING_OPERATION_PROGRESS, handler);
	},
	onOperationComplete: (callback) => {
		const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.SELF_HEALING_OPERATION_COMPLETE, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.SELF_HEALING_OPERATION_COMPLETE, handler);
	},
});
