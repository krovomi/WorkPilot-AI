/**
 * The world the MCP Marketplace tests run in: the shipped catalog, the real
 * marketplace and project stores, the English texts, and a main process
 * (`window.electronAPI`) whose answers each test sets.
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { loadMcpCatalog } from "../../../../shared/mcp-catalog/install";
import type { McpMarketplaceServer } from "../../../../shared/types/mcp-marketplace";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { useProjectStore } from "../../../stores/project-store";

export const CATALOG = loadMcpCatalog();

export function entry(id: string): McpMarketplaceServer {
	return CATALOG.find((s) => s.id === id) as McpMarketplaceServer;
}

const MARKETPLACE = useMcpMarketplaceStore.getState();
const PROJECTS = useProjectStore.getState();

export type MainApi = Record<string, ReturnType<typeof vi.fn>>;

/** Resets the stores and the language, and installs a fresh main process. */
export async function resetWorld(): Promise<MainApi> {
	const api: MainApi = {
		invoke: vi.fn(),
		getProjectEnv: vi.fn(async () => ({ success: true, data: {} })),
		updateProjectEnv: vi.fn(async () => ({ success: true })),
		getMcpServerSecurity: vi.fn(async () => ({ success: false })),
		getMcpInstallPolicy: vi.fn(async () => ({ success: true, data: { state: "none" } })),
		getMcpInstalledWatch: vi.fn(async () => ({ success: true, data: { servers: [] } })),
		acknowledgeMcpAlerts: vi.fn(async () => ({ success: true, data: true })),
	};
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useMcpMarketplaceStore.setState(MARKETPLACE, true);
	useMcpMarketplaceStore.setState({ filters: { ...MARKETPLACE.filters } });
	useProjectStore.setState(PROJECTS, true);
	await i18n.changeLanguage("en");
	return api;
}

/** Selects project `id` (named `name`), or none. */
export function selectProject(id: string | null, name = "Shop"): void {
	act(() =>
		useProjectStore.setState({
			selectedProjectId: id,
			projects: id ? ([{ id, name }] as never) : [],
		}),
	);
}
