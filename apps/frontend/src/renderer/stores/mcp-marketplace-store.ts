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

/** What went wrong, worded by the view (`mcpMarketplace.errors.<key>`). */
export type McpMarketplaceErrorKey =
	| "loadCatalog"
	| "loadBuilder"
	| "unknownServer"
	| "missingValues"
	| "alreadyInstalled"
	| "readSettings"
	| "saveSettings"
	| "install"
	| "uninstall"
	| "saveBuilder"
	| "deleteBuilder";

export interface McpMarketplaceError {
	key: McpMarketplaceErrorKey;
	/** The server, or the missing values, the sentence names */
	name?: string;
	/** The main process's or the exception's own message, when there is one */
	detail?: string;
}

function failure(
	key: McpMarketplaceErrorKey,
	detail?: unknown,
	name?: string,
): McpMarketplaceError {
	const text =
		detail instanceof Error ? detail.message : typeof detail === "string" ? detail : "";
	return { key, ...(name ? { name } : {}), ...(text ? { detail: text } : {}) };
}

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
	error: McpMarketplaceError | null;

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
	setError: (error: McpMarketplaceError | null) => void;

	getFilteredCatalog: () => McpMarketplaceServer[];
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
			store.setError(failure("loadCatalog", result?.error));
		}
	} catch (err) {
		store.setError(failure("loadCatalog", err));
	} finally {
		store.setCatalogLoading(false);
	}
}

/** The latest read of a project's servers; an older answer is dropped. */
let installedRead = 0;

/**
 * Reads the project's custom MCP servers and agent overrides; false when they
 * could not be read, the store then still holding what it held before. The
 * answer of a read that a later one (another project) replaced is dropped,
 * and false.
 */
export async function loadInstalledServers(
	projectId: string | null | undefined,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();
	const read = ++installedRead;
	if (!projectId) {
		store.setProjectServers(null, [], {});
		store.setInstalledLoading(false);
		return true;
	}
	store.setInstalledLoading(true);
	try {
		const result = await globalThis.electronAPI.getProjectEnv(projectId);
		if (read !== installedRead) return false;
		if (result?.success && result.data) {
			store.setProjectServers(
				projectId,
				result.data.customMcpServers ?? [],
				result.data.agentMcpOverrides ?? {},
			);
		} else {
			store.setProjectServers(projectId, [], {});
		}
		return true;
	} catch (err) {
		console.error("[MCP Marketplace] Failed to load project servers:", err);
		if (read === installedRead) store.setError(failure("readSettings", err));
		return false;
	} finally {
		if (read === installedRead) store.setInstalledLoading(false);
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
		store.setError(failure("saveSettings", result?.error));
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
	store.setError(null);
	const entry = store.catalog.find((s) => s.id === serverId);
	if (!entry) {
		store.setError(failure("unknownServer", undefined, serverId));
		return false;
	}
	const built = buildCatalogServer(entry, values, language);
	if (!built.ok) {
		store.setError(failure("missingValues", undefined, built.missing.join(", ")));
		return false;
	}
	store.setIsInstalling(serverId);
	try {
		// Read the file again: the Agent Tools panel may have changed it. After
		// a failed read the store still holds an older (or another project's)
		// list, and writing it would replace this project's servers.
		if (!(await loadInstalledServers(projectId))) {
			store.setError(useMcpMarketplaceStore.getState().error ?? failure("readSettings"));
			return false;
		}
		const { installed, agentOverrides } = useMcpMarketplaceStore.getState();
		if (installed.some((s) => s.id === serverId)) {
			store.setError(failure("alreadyInstalled", undefined, entry.name));
			return false;
		}
		return await saveProjectServers(
			projectId,
			[...installed, built.server],
			withServerForAgents(agentOverrides, serverId, agents),
		);
	} catch (err) {
		store.setError(failure("install", err));
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
	const store = useMcpMarketplaceStore.getState();
	store.setError(null);
	try {
		if (!(await loadInstalledServers(projectId))) {
			store.setError(useMcpMarketplaceStore.getState().error ?? failure("readSettings"));
			return false;
		}
		const { installed, agentOverrides } = useMcpMarketplaceStore.getState();
		return await saveProjectServers(
			projectId,
			installed.filter((s) => s.id !== serverId),
			withoutServer(agentOverrides, serverId),
		);
	} catch (err) {
		store.setError(failure("uninstall", err));
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
		} else {
			store.setError(failure("loadBuilder", result?.error));
		}
	} catch (err) {
		console.error("[MCP Marketplace] Failed to load builder projects:", err);
		store.setError(failure("loadBuilder", err));
	} finally {
		store.setBuilderLoading(false);
	}
}

export async function saveBuilderProject(
	project: McpBuilderProject,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();
	store.setError(null);

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
		store.setError(failure("saveBuilder", result?.error));
		return false;
	} catch (err) {
		store.setError(failure("saveBuilder", err));
		return false;
	}
}

export async function deleteBuilderProject(
	projectId: string,
): Promise<boolean> {
	const store = useMcpMarketplaceStore.getState();
	store.setError(null);

	try {
		const result = await globalThis.electronAPI?.invoke(
			"mcpMarketplace:deleteBuilder",
			{ projectId },
		);
		if (result?.success) {
			store.removeBuilderProject(projectId);
			return true;
		}
		store.setError(failure("deleteBuilder", result?.error));
		return false;
	} catch (err) {
		store.setError(failure("deleteBuilder", err));
		return false;
	}
}
