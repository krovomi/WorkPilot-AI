import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";

export interface ApiExplorerProxyResponse {
	success: boolean;
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	time?: number;
	error?: string;
}

export interface ApiExplorerSecretValues {
	bearer?: string;
	password?: string;
	keyValue?: string;
	oauth2ClientSecret?: string;
	oauth2AccessToken?: string;
	environmentToken?: string;
}

export interface ApiExplorerAPI {
	scanProjectRoutes: (
		projectPath: string,
		projectName: string,
	) => Promise<{
		success: boolean;
		data?: Record<string, unknown>;
		routeCount?: number;
		frameworks?: string[];
		specUrls?: string[];
		error?: string;
	}>;
	proxyHttpRequest: (payload: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body?: string;
	}) => Promise<ApiExplorerProxyResponse>;
	loadApiExplorerSecrets: (scope: string) => Promise<{
		success: boolean;
		data?: ApiExplorerSecretValues;
		error?: string;
	}>;
	saveApiExplorerSecrets: (
		scope: string,
		values: ApiExplorerSecretValues,
	) => Promise<{ success: boolean; error?: string }>;
}

export const createApiExplorerAPI = (): ApiExplorerAPI => ({
	scanProjectRoutes: (projectPath: string, projectName: string) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.API_EXPLORER_SCAN_ROUTES,
			projectPath,
			projectName,
		),
	proxyHttpRequest: (payload) =>
		ipcRenderer.invoke(IPC_CHANNELS.API_EXPLORER_PROXY_REQUEST, payload),
	loadApiExplorerSecrets: (scope) =>
		ipcRenderer.invoke(IPC_CHANNELS.API_EXPLORER_LOAD_SECRETS, scope),
	saveApiExplorerSecrets: (scope, values) =>
		ipcRenderer.invoke(IPC_CHANNELS.API_EXPLORER_SAVE_SECRETS, scope, values),
});
