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
	McpMarketplaceFailure,
} from "../../shared/types/mcp-marketplace";
import { appLog } from "../app-logger";
import {
	hasRoomForProject,
	parseBuilderId,
	parseBuilderProject,
	validBuilderProjects,
} from "./mcp-builder-args";
import { registerMcpReviewHandlers } from "./mcp-reviews-handlers";
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
	scoreDeps,
	startMcpInstalledWatch,
	watchDeps,
} from "../mcp-security/runtime";
import {
	McpSecurityRequestError,
	serverSecurity,
} from "../mcp-security/server-security";
import { projectStore } from "../project-store";
import { searchHuggingFaceModels } from "../services/hf-mcp-client";

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

/** Throws when the file cannot be written: the caller says so to the renderer. */
function saveBuilderToDisk(projects: McpBuilderProject[]): void {
	fs.writeFileSync(getBuilderProjectsPath(), JSON.stringify(projects, null, 2), "utf-8");
}

/** A refusal or failure, as a code the renderer words. */
function refused(error: McpMarketplaceFailure): { success: false; error: McpMarketplaceFailure } {
	return { success: false, error };
}

/** The registered project `raw` names, checked (S6). */
function requestedProject(raw: unknown) {
	const { projectId } = parseWatchRequest(raw);
	const project = projectStore.getProject(projectId);
	if (!project) throw new McpWatchRequestError("watchUnknownProject");
	return project;
}

/** A refused watch request with its reason, any other failure as `code`. */
function watchFailure(error: unknown, code: McpMarketplaceFailure, what: string) {
	if (error instanceof McpWatchRequestError) return refused(error.code);
	appLog.error(`[MCP Marketplace] ${what}:`, error);
	return refused(code);
}

// ============================================
// Register IPC Handlers
// ============================================

export function registerMcpMarketplaceHandlers(): void {
	// Get the full catalog
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_CATALOG, async () => ({
		success: true,
		data: loadMcpCatalog(),
	}));

	// Save builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER,
		async (_event, request: unknown) => {
			try {
				const project = parseBuilderProject(request);
				if (!project) {
					return refused("invalidBuilderRequest");
				}
				const projects = loadBuilderFromDisk();
				const idx = projects.findIndex((p) => p.id === project.id);
				if (idx >= 0) {
					projects[idx] = project;
				} else if (hasRoomForProject(projects.length)) {
					projects.push(project);
				} else {
					return refused("tooManyBuilderProjects");
				}
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] saveBuilder error:", error);
				return refused("builderSaveFailed");
			}
		},
	);

	// Get builder projects
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS,
		// An unreadable file is logged and read as empty (loadBuilderFromDisk).
		async () => ({ success: true, data: loadBuilderFromDisk() }),
	);

	// Delete builder project
	ipcMain.handle(
		IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER,
		async (_event, request: unknown) => {
			try {
				const projectId = parseBuilderId(request);
				if (!projectId) {
					return refused("invalidBuilderRequest");
				}
				let projects = loadBuilderFromDisk();
				projects = projects.filter((p) => p.id !== projectId);
				saveBuilderToDisk(projects);
				return { success: true };
			} catch (error) {
				appLog.error("[MCP Marketplace] deleteBuilder error:", error);
				return refused("builderDeleteFailed");
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
					...scoreDeps(),
					projectPath: (id) => projectStore.getProject(id)?.path,
				});
				return { success: true, data };
			} catch (error) {
				if (error instanceof McpSecurityRequestError) {
					return refused(error.code);
				}
				appLog.error("[MCP Marketplace] security error:", error);
				return refused("securityFailed");
			}
		},
	);

	// The project's MCP install policy (#369): read by the main from the
	// project's own folder, applied by env:update; the renderer only explains.
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, async (_event, request: unknown) => {
		try {
			return { success: true, data: readMcpPolicy(requestedProject(request).path) };
		} catch (error) {
			return watchFailure(error, "policyReadFailed", "Failed to read the MCP policy");
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
				return watchFailure(error, "watchReadFailed", "Failed to read the installed servers' alerts");
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
				return watchFailure(error, "acknowledgeFailed", "Failed to acknowledge the alerts");
			}
		},
	);

	// The team's reviews of a catalog server, for a server project (#369).
	registerMcpReviewHandlers();

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
