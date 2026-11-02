/**
 * MCP Marketplace IPC Handlers
 *
 * Serves the catalog (`shared/mcp-catalog/servers.json`) and the builder
 * projects. Installing a server is a change to the project's
 * `.workpilot/.env` (`CUSTOM_MCP_SERVERS`, `AGENT_MCP_*`), made by the
 * renderer through `updateProjectEnv` like the Agent Tools panel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { loadMcpCatalog } from "../../shared/mcp-catalog/install";
import type {
	HuggingFaceModelSearchParams,
	McpBuilderProject,
} from "../../shared/types/mcp-marketplace";
import { appLog } from "../app-logger";
import { searchHuggingFaceModels } from "../services/hf-mcp-client";

// ============================================
// Storage paths
// ============================================

function getMarketplaceDataDir(): string {
	const userDataPath = app.getPath("userData");
	const dir = path.join(userDataPath, "mcp-marketplace");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getBuilderProjectsPath(): string {
	return path.join(getMarketplaceDataDir(), "builder-projects.json");
}

// ============================================
// Data persistence helpers
// ============================================

function loadBuilderFromDisk(): McpBuilderProject[] {
	try {
		const filePath = getBuilderProjectsPath();
		if (fs.existsSync(filePath)) {
			const data = fs.readFileSync(filePath, "utf-8");
			return JSON.parse(data);
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
		async (_event, project: McpBuilderProject) => {
			try {
				const projects = loadBuilderFromDisk();
				const idx = projects.findIndex((p) => p.id === project.id);
				if (idx >= 0) {
					projects[idx] = project;
				} else {
					projects.push(project);
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
		async (_event, { projectId }: { projectId: string }) => {
			try {
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

	// Live Hugging Face Hub model search (via the official HF MCP server).
	// Powers the "Discover models" settings panel.
	ipcMain.handle(
		IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS,
		async (_event, params: HuggingFaceModelSearchParams) => {
			return searchHuggingFaceModels(params || {});
		},
	);

	appLog.info("[MCP Marketplace] All handlers registered");
}
