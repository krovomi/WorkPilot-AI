/**
 * MCP Marketplace IPC Handlers
 *
 * Serves the catalog (`shared/mcp-catalog/servers.json`) and the builder
 * projects. Installing a server is a change to the project's
 * `.workpilot/.env` (`CUSTOM_MCP_SERVERS`, `AGENT_MCP_*`), made by the
 * renderer through `updateProjectEnv` like the Agent Tools panel.
 */

import { debugLog } from "../../shared/utils/debug-logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { loadMcpCatalog } from "../../shared/mcp-catalog/install";
import type {
	HuggingFaceModelSearchParams,
	McpBuilderProject,
} from "../../shared/types/mcp-marketplace";
import { appLog } from "../app-logger";
import {
	hasRoomForProject,
	parseBuilderId,
	parseBuilderProject,
	validBuilderProjects,
} from "./mcp-builder-args";
import {
	installedWatchView,
	McpWatchRequestError,
	parseAcknowledgeRequest,
	parseWatchRequest,
} from "../mcp-security/installed-watch";
import { readMcpPolicy } from "../mcp-security/policy-file";
import {
	installedWatchStore,
	marketplaceDataDir,
	securityStore,
	startMcpInstalledWatch,
	watchDeps,
} from "../mcp-security/runtime";
import {
	McpSecurityRequestError,
	serverSecurity,
} from "../mcp-security/server-security";
import { projectStore } from "../project-store";
import { searchHuggingFaceModels } from "../services/hf-mcp-client";
import { offlineStrict } from "./task/split-merge-watch";

function getBuilderProjectsPath(): string {
	return path.join(marketplaceDataDir(), "builder-projects.json");
}

// ============================================
// Data persistence helpers
// ============================================

function loadBuilderFromDisk(): McpBuilderProject[] {
	try {
		const filePath = getBuilderProjectsPath();
		if (fs.existsSync(filePath)) {
			const data = fs.readFileSync(filePath, "utf-8");
			return validBuilderProjects(JSON.parse(data));
		}
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to load builder projects:", err);
	}
	return [];
}

function saveBuilderToDisk(projects: McpBuilderProject[]): void {
	try {
		const filePath = getBuilderProjectsPath();
		fs.writeFileSync(filePath, JSON.stringify(projects, null, 2), "utf-8");
	} catch (err) {
		appLog.error("[MCP Marketplace] Failed to save builder projects:", err);
	}
}

/** The registered project `raw` names, checked (S6). */
function requestedProject(raw: unknown) {
	const { projectId } = parseWatchRequest(raw);
	const project = projectStore.getProject(projectId);
	if (!project) throw new McpWatchRequestError("Project not found");
	return project;
}

function watchFailure(error: unknown, message: string) {
	if (error instanceof McpWatchRequestError) return { success: false, error: error.message };
	appLog.error(`[MCP Marketplace] ${message}:`, error);
	return { success: false, error: message };
}

// ============================================
// Register IPC Handlers
// ============================================

export function registerMcpMarketplaceHandlers(): void {
	// Get the full catalog
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_CATALOG, async () => {
		try {
			const catalog = loadMcpCatalog();
			return { success: true, data: catalog };
		} catch (error) {
			appLog.error("[MCP Marketplace] getCatalog error:", error);
			return { success: false, error: "Failed to load catalog" };
		}
	});

	// Get single server details
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_SERVER,
		async (_event, serverId: string) => {
			try {
				const catalog = loadMcpCatalog();
				const server = catalog.find((s) => s.id === serverId);
				if (!server) {
					return { success: false, error: "Server not found" };
				}
				return { success: true, data: server };
			} catch (error) {
				appLog.error("[MCP Marketplace] getServer error:", error);
				return { success: false, error: "Failed to get server details" };
			}
		},
	);

	// Save builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER,
		async (_event, request: unknown) => {
			try {
				const project = parseBuilderProject(request);
				if (!project) {
					return { success: false, error: "Invalid builder project" };
				}
				const projects = loadBuilderFromDisk();
				const idx = projects.findIndex((p) => p.id === project.id);
				if (idx >= 0) {
					projects[idx] = project;
				} else if (hasRoomForProject(projects.length)) {
					projects.push(project);
				} else {
					return { success: false, error: "Too many builder projects" };
				}
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] saveBuilder error:", error);
				return { success: false, error: "Save failed" };
			}
		},
	);

	// Get builder projects
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS,
		async () => {
			try {
				const projects = loadBuilderFromDisk();
				return { success: true, data: projects };
			} catch (error) {
				appLog.error("[MCP Marketplace] getBuilderProjects error:", error);
				return { success: false, error: "Failed to load builder projects" };
			}
		},
	);

	// Delete builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER,
		async (_event, request: unknown) => {
			try {
				const projectId = parseBuilderId(request);
				if (!projectId) {
					return { success: false, error: "Invalid builder project" };
				}
				let projects = loadBuilderFromDisk();
				projects = projects.filter((p) => p.id !== projectId);
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] deleteBuilder error:", error);
				return { success: false, error: "Delete failed" };
			}
		},
	);

	// Security score of a catalog server (#369): the renderer names a server
	// id and the project it installs into, both checked in serverSecurity.
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_SECURITY,
		async (_event, request: unknown) => {
			try {
				const data = await serverSecurity(request, {
					store: securityStore(),
					projectPath: (id) => projectStore.getProject(id)?.path,
					offline: offlineStrict,
				});
				return { success: true, data };
			} catch (error) {
				if (error instanceof McpSecurityRequestError) {
					return { success: false, error: error.message };
				}
				appLog.error("[MCP Marketplace] security error:", error);
				return { success: false, error: "Failed to score the server" };
			}
		},
	);

	// The project's MCP install policy (#369): read by the main from the
	// project's own folder, applied by env:update; the renderer only explains.
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, async (_event, request: unknown) => {
		try {
			return { success: true, data: readMcpPolicy(requestedProject(request).path) };
		} catch (error) {
			return watchFailure(error, "Failed to read the MCP policy");
		}
	});

	// Alerts of the daily check on the project's installed servers (#369).
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH,
		async (_event, request: unknown) => {
			try {
				const project = requestedProject(request);
				return {
					success: true,
					data: installedWatchView({ id: project.id, path: project.path }, watchDeps()),
				};
			} catch (error) {
				return watchFailure(error, "Failed to read the installed servers' alerts");
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS,
		async (_event, request: unknown) => {
			try {
				const { serverId } = parseAcknowledgeRequest(request);
				return { success: true, data: installedWatchStore().acknowledge(serverId, Date.now()) };
			} catch (error) {
				return watchFailure(error, "Failed to acknowledge the alerts");
			}
		},
	);

	startMcpInstalledWatch();

	// Live Hugging Face Hub model search (via the official HF MCP server).
	// Powers the "Discover models" settings panel.
	ipcMain.handle(
		IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS,
		async (_event, params: HuggingFaceModelSearchParams) => {
			return searchHuggingFaceModels(params || {});
		},
	);

	debugLog("[MCP Marketplace] All handlers registered");
}
