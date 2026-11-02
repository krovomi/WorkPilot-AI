/**
 * Plugin Marketplace Store
 *
 * Zustand store for the Plugin Marketplace. A plugin installs as a skill of
 * the selected project (`.agents/skills/<id>/` and `.claude/skills/<id>/`), so
 * "installed" is read from that project's folders by the main process.
 */

import { create } from "zustand";
import type {
	InstalledPlugin,
	MarketplacePlugin,
	PluginMarketplaceFilters,
	PluginMarketplaceTab,
} from "../../shared/types/plugin-marketplace";

interface PluginMarketplaceState {
	activeTab: PluginMarketplaceTab;
	filters: PluginMarketplaceFilters;
	isInstalling: string | null;

	catalog: MarketplacePlugin[];
	/** Project whose skills `installed` lists */
	projectId: string | null;
	installed: InstalledPlugin[];

	isCatalogLoading: boolean;
	isInstalledLoading: boolean;
	error: string | null;

	setActiveTab: (tab: PluginMarketplaceTab) => void;
	setFilters: (filters: Partial<PluginMarketplaceFilters>) => void;
	setCatalog: (catalog: MarketplacePlugin[]) => void;
	setInstalled: (projectId: string | null, installed: InstalledPlugin[]) => void;
	setIsInstalling: (pluginId: string | null) => void;
	setCatalogLoading: (loading: boolean) => void;
	setInstalledLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;

	getFilteredCatalog: () => MarketplacePlugin[];
	isPluginInstalled: (pluginId: string) => boolean;
}

const defaultFilters: PluginMarketplaceFilters = {
	search: "",
	type: "all",
	sortBy: "featured",
	showInstalledOnly: false,
};

export const usePluginMarketplaceStore = create<PluginMarketplaceState>(
	(set, get) => ({
		activeTab: "catalog",
		filters: { ...defaultFilters },
		isInstalling: null,
		catalog: [],
		projectId: null,
		installed: [],
		isCatalogLoading: false,
		isInstalledLoading: false,
		error: null,

		setActiveTab: (tab) => set({ activeTab: tab }),
		setFilters: (updates) =>
			set((state) => ({ filters: { ...state.filters, ...updates } })),
		setCatalog: (catalog) => set({ catalog }),
		setInstalled: (projectId, installed) => set({ projectId, installed }),
		setIsInstalling: (pluginId) => set({ isInstalling: pluginId }),
		setCatalogLoading: (loading) => set({ isCatalogLoading: loading }),
		setInstalledLoading: (loading) => set({ isInstalledLoading: loading }),
		setError: (error) => set({ error }),

		getFilteredCatalog: () => {
			const { catalog, installed, filters } = get();
			let filtered = [...catalog];

			if (filters.search) {
				const query = filters.search.toLowerCase();
				filtered = filtered.filter(
					(p) =>
						p.name.toLowerCase().includes(query) ||
						p.tagline.en.toLowerCase().includes(query) ||
						p.tagline.fr.toLowerCase().includes(query) ||
						p.description.en.toLowerCase().includes(query) ||
						p.description.fr.toLowerCase().includes(query) ||
						p.tags.some((t) => t.toLowerCase().includes(query)),
				);
			}

			if (filters.type !== "all") {
				filtered = filtered.filter((p) => p.type === filters.type);
			}

			if (filters.showInstalledOnly) {
				const installedIds = new Set(installed.map((i) => i.pluginId));
				filtered = filtered.filter((p) => installedIds.has(p.id));
			}

			// "featured" keeps the catalog's own order.
			if (filters.sortBy === "name") {
				filtered.sort((a, b) => a.name.localeCompare(b.name));
			}

			return filtered;
		},

		isPluginInstalled: (pluginId) =>
			get().installed.some((p) => p.pluginId === pluginId),
	}),
);

// ============================================
// Async action helpers
// ============================================

export async function loadPluginCatalog(): Promise<void> {
	const store = usePluginMarketplaceStore.getState();
	store.setCatalogLoading(true);
	store.setError(null);
	try {
		const result = await globalThis.electronAPI?.invoke(
			"pluginMarketplace:getCatalog",
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

/** Reads which catalog plugins the project has as skills. */
export async function loadInstalledPlugins(
	projectId: string | null | undefined,
): Promise<void> {
	const store = usePluginMarketplaceStore.getState();
	if (!projectId) {
		store.setInstalled(null, []);
		return;
	}
	store.setInstalledLoading(true);
	try {
		const result = await globalThis.electronAPI?.invoke(
			"pluginMarketplace:getInstalled",
			{ projectId },
		);
		store.setInstalled(projectId, result?.success ? result.data : []);
	} catch (err) {
		console.error(
			"[Plugin Marketplace] Failed to load installed plugins:",
			err,
		);
	} finally {
		store.setInstalledLoading(false);
	}
}

export async function installPlugin(
	projectId: string,
	pluginId: string,
): Promise<boolean> {
	const store = usePluginMarketplaceStore.getState();
	store.setIsInstalling(pluginId);
	store.setError(null);
	try {
		const result = await globalThis.electronAPI?.invoke(
			"pluginMarketplace:install",
			{ projectId, pluginId },
		);
		if (result?.success) {
			await loadInstalledPlugins(projectId);
			return true;
		}
		store.setError(result?.error || "Installation failed");
		return false;
	} catch (err) {
		store.setError(err instanceof Error ? err.message : "Installation failed");
		return false;
	} finally {
		store.setIsInstalling(null);
	}
}

export async function uninstallPlugin(
	projectId: string,
	pluginId: string,
): Promise<boolean> {
	const store = usePluginMarketplaceStore.getState();
	try {
		const result = await globalThis.electronAPI?.invoke(
			"pluginMarketplace:uninstall",
			{ projectId, pluginId },
		);
		if (result?.success) {
			await loadInstalledPlugins(projectId);
			return true;
		}
		store.setError(result?.error || "Uninstall failed");
		return false;
	} catch {
		return false;
	}
}
