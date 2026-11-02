/**
 * MCP Marketplace Store
 *
 * Zustand store for the MCP Marketplace feature: the catalog, what the
 * selected project has installed, and builder projects.
 *
 * "Installed" is read from the project's `.workpilot/.env`: a catalog server
 * is installed when the project has a custom MCP server with its id
 * (`CUSTOM_MCP_SERVERS`), and the agents that use it are those whose
 * `AGENT_MCP_<agent>_ADD` names it. Installing writes both, so agents start
 * the server on their next session.
 */

import { create } from "zustand";
import {
	buildCatalogServer,
	withoutServer,
	withServerForAgents,
} from "../../shared/mcp-catalog/install";
import type {
	McpBuilderProject,
	McpMarketplaceFilters,
	McpMarketplaceServer,
	McpMarketplaceTab,
} from "../../shared/types/mcp-marketplace";
import type {
	AgentMcpOverrides,
	CustomMcpServer,
} from "../../shared/types/project";

interface McpMarketplaceState {
	activeTab: McpMarketplaceTab;
	filters: McpMarketplaceFilters;
	isInstalling: string | null;

	catalog: McpMarketplaceServer[];
	/** Project whose servers `installed` and `agentOverrides` describe */
	projectId: string | null;
	/** The project's custom MCP servers */
	installed: CustomMcpServer[];
	agentOverrides: AgentMcpOverrides;
	builderProjects: McpBuilderProject[];

	isCatalogLoading: boolean;
	isInstalledLoading: boolean;
	isBuilderLoading: boolean;
	error: string | null;

	setActiveTab: (tab: McpMarketplaceTab) => void;
	setFilters: (filters: Partial<McpMarketplaceFilters>) => void;

	setCatalog: (catalog: McpMarketplaceServer[]) => void;
	setProjectServers: (
		projectId: string | null,
		installed: CustomMcpServer[],
		agentOverrides: AgentMcpOverrides,
	) => void;
	setBuilderProjects: (projects: McpBuilderProject[]) => void;
	addBuilderProject: (project: McpBuilderProject) => void;
	updateBuilderProject: (
		projectId: string,
		updates: Partial<McpBuilderProject>,
	) => void;
	removeBuilderProject: (projectId: string) => void;

	setIsInstalling: (serverId: string | null) => void;
	setCatalogLoading: (loading: boolean) => void;
	setInstalledLoading: (loading: boolean) => void;
	setBuilderLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;

	getFilteredCatalog: () => McpMarketplaceServer[];
	isServerInstalled: (serverId: string) => boolean;
}

const defaultFilters: McpMarketplaceFilters = {
	search: "",
	category: "all",
	sortBy: "featured",
	showInstalledOnly: false,
	showOfficialOnly: false,
};

export const useMcpMarketplaceStore = create<McpMarketplaceState>(
	(set, get) => ({
		activeTab: "catalog",
		filters: { ...defaultFilters },
		isInstalling: null,
		catalog: [],
		projectId: null,
		installed: [],
		agentOverrides: {},
		builderProjects: [],
		isCatalogLoading: false,
		isInstalledLoading: false,
		isBuilderLoading: false,
		error: null,

		setActiveTab: (tab) => set({ activeTab: tab }),

		setFilters: (updates) =>
			set((state) => ({
				filters: { ...state.filters, ...updates },
			})),

		setCatalog: (catalog) => set({ catalog }),

		setProjectServers: (projectId, installed, agentOverrides) =>
			set({ projectId, installed, agentOverrides }),

		setBuilderProjects: (projects) => set({ builderProjects: projects }),

		addBuilderProject: (project) =>
			set((state) => ({
				builderProjects: [...state.builderProjects, project],
			})),

		updateBuilderProject: (projectId, updates) =>
			set((state) => ({
				builderProjects: state.builderProjects.map((p) =>
					p.id === projectId ? { ...p, ...updates } : p,
				),
			})),

		removeBuilderProject: (projectId) =>
			set((state) => ({
				builderProjects: state.builderProjects.filter(
					(p) => p.id !== projectId,
				),
			})),

		setIsInstalling: (serverId) => set({ isInstalling: serverId }),
		setCatalogLoading: (loading) => set({ isCatalogLoading: loading }),
		setInstalledLoading: (loading) => set({ isInstalledLoading: loading }),
		setBuilderLoading: (loading) => set({ isBuilderLoading: loading }),
		setError: (error) => set({ error }),

		getFilteredCatalog: () => {
			const { catalog, installed, filters } = get();
			let filtered = [...catalog];

			if (filters.search) {
				const query = filters.search.toLowerCase();
				filtered = filtered.filter(
					(s) =>
						s.name.toLowerCase().includes(query) ||
						s.tagline.en.toLowerCase().includes(query) ||
						s.tagline.fr.toLowerCase().includes(query) ||
						s.description.en.toLowerCase().includes(query) ||
						s.description.fr.toLowerCase().includes(query) ||
						s.tags.some((t) => t.toLowerCase().includes(query)),
				);
			}

			if (filters.category !== "all") {
				filtered = filtered.filter((s) => s.category === filters.category);
			}

			if (filters.showInstalledOnly) {
				const installedIds = new Set(installed.map((i) => i.id));
				filtered = filtered.filter((s) => installedIds.has(s.id));
			}

			if (filters.showOfficialOnly) {
				filtered = filtered.filter((s) => s.official);
			}

			// "featured" keeps the catalog's own order.
			if (filters.sortBy === "name") {
				filtered.sort((a, b) => a.name.localeCompare(b.name));
			}

			return filtered;
		},

		isServerInstalled: (serverId) => {
			return get().installed.some((s) => s.id === serverId);
		},
	}),
);

export async function loadMarketplaceCatalog(): Promise<void> {
	const store = useMcpMarketplaceStore.getState();
	store.setCatalogLoading(true);
	store.setError(null);

	try {
		const result = await globalThis.electronAPI?.invoke(
			"mcpMarketplace:getCatalog",
		);
		if (result?.success) {
			store.setCatalog(result.data);
		} else {
			store.setError(result?.error || "Failed to load catalog");
		}
	} catch (err) {
		store.setError(
			err instanceof Error ? err.message : "Failed to load catalog",
		);
	} finally {
		store.setCatalogLoading(false);
	}
}

/** Reads the project's custom MCP servers and agent overrides. */
export async function loadInstalledServers(
	projectId: string | null | undefined,
): Promise<void> {
	const store = useMcpMarketplaceStore.getState();
	if (!projectId) {
		store.setProjectServers(null, [], {});
		return;
	}
	store.setInstalledLoading(true);
	try {
		const result = await globalThis.electronAPI.getProjectEnv(projectId);
		if (result?.success && result.data) {
			store.setProjectServers(
				projectId,
				result.data.customMcpServers ?? [],
				result.data.agentMcpOverrides ?? {},
			);
		} else {
			store.setProjectServers(projectId, [], {});
		}
	} catch (err) {
		console.error("[MCP Marketplace] Failed to load project servers:", err);
	} finally {
		store.setInstalledLoading(false);
	}
}

/** Writes `servers` and `overrides` to the project, then mirrors them. */
async function saveProjectServers(
	projectId: string,
	servers: CustomMcpServer[],
	overrides: AgentMcpOverrides,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();
	const result = await globalThis.electronAPI.updateProjectEnv(projectId, {
		customMcpServers: servers,
		agentMcpOverrides: overrides,
	});
	if (!result?.success) {
		store.setError(result?.error || "Failed to save the project settings");
		return false;
	}
	store.setProjectServers(projectId, servers, overrides);
	return true;
}

/**
 * Adds catalog server `serverId` to the project and to `agents`, with the
 * values the user typed. Fails when a required value is empty or the project
 * already has a server with that id.
 */
export async function installMarketplaceServer(
	projectId: string,
	serverId: string,
	values: Record<string, string>,
	agents: readonly string[],
	language = "en",
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();
	const entry = store.catalog.find((s) => s.id === serverId);
	if (!entry) {
		store.setError(`Unknown server: ${serverId}`);
		return false;
	}
	const built = buildCatalogServer(entry, values, language);
	if (!built.ok) {
		store.setError(`Missing: ${built.missing.join(", ")}`);
		return false;
	}
	store.setIsInstalling(serverId);
	try {
		// Read the file again: the Agent Tools panel may have changed it.
		await loadInstalledServers(projectId);
		const { installed, agentOverrides } = useMcpMarketplaceStore.getState();
		if (installed.some((s) => s.id === serverId)) {
			store.setError(`${entry.name} is already installed in this project`);
			return false;
		}
		return await saveProjectServers(
			projectId,
			[...installed, built.server],
			withServerForAgents(agentOverrides, serverId, agents),
		);
	} catch (err) {
		store.setError(err instanceof Error ? err.message : "Installation failed");
		return false;
	} finally {
		store.setIsInstalling(null);
	}
}

/** Removes `serverId` from the project and from every agent. */
export async function uninstallMarketplaceServer(
	projectId: string,
	serverId: string,
): Promise<boolean> {
	try {
		await loadInstalledServers(projectId);
		const { installed, agentOverrides } = useMcpMarketplaceStore.getState();
		return await saveProjectServers(
			projectId,
			installed.filter((s) => s.id !== serverId),
			withoutServer(agentOverrides, serverId),
		);
	} catch {
		return false;
	}
}

export async function loadBuilderProjects(): Promise<void> {
	const store = useMcpMarketplaceStore.getState();
	store.setBuilderLoading(true);

	try {
		const result = await globalThis.electronAPI?.invoke(
			"mcpMarketplace:getBuilderProjects",
		);
		if (result?.success) {
			store.setBuilderProjects(result.data);
		}
	} catch (err) {
		console.error("[MCP Marketplace] Failed to load builder projects:", err);
	} finally {
		store.setBuilderLoading(false);
	}
}

export async function saveBuilderProject(
	project: McpBuilderProject,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();

	try {
		const result = await globalThis.electronAPI?.invoke(
			"mcpMarketplace:saveBuilder",
			project,
		);
		if (result?.success) {
			const existing = store.builderProjects.find((p) => p.id === project.id);
			if (existing) {
				store.updateBuilderProject(project.id, project);
			} else {
				store.addBuilderProject(project);
			}
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export async function deleteBuilderProject(
	projectId: string,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();

	try {
		const result = await globalThis.electronAPI?.invoke(
			"mcpMarketplace:deleteBuilder",
			{ projectId },
		);
		if (result?.success) {
			store.removeBuilderProject(projectId);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
