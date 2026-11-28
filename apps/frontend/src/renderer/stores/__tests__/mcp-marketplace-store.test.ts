/**
 * The MCP Marketplace store: filtering the catalog, what a project has
 * installed (read from its `.workpilot/.env`), installing and removing a
 * catalog server for chosen agents, and builder projects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import {
	deleteBuilderProject,
	installMarketplaceServer,
	loadBuilderProjects,
	loadInstalledServers,
	loadMarketplaceCatalog,
	saveBuilderProject,
	uninstallMarketplaceServer,
	useMcpMarketplaceStore,
} from "../mcp-marketplace-store";

const api = {
	invoke: vi.fn(),
	getProjectEnv: vi.fn(),
	updateProjectEnv: vi.fn(),
};

const INITIAL = useMcpMarketplaceStore.getState();
const store = () => useMcpMarketplaceStore.getState();

function server(id: string, overrides: Partial<McpMarketplaceServer> = {}): McpMarketplaceServer {
	return {
		id,
		name: id.toUpperCase(),
		tagline: { en: `${id} tagline`, fr: `slogan ${id}` },
		description: { en: `${id} description`, fr: `description ${id}` },
		category: "database",
		official: false,
		tags: [],
		transport: "stdio",
		command: "npx",
		args: ["-y", `@acme/${id}`],
		vars: [{ name: "TOKEN", label: "Token", required: true }],
		...overrides,
	} as McpMarketplaceServer;
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useMcpMarketplaceStore.setState(INITIAL, true);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("catalog filters", () => {
	beforeEach(() => {
		useMcpMarketplaceStore.setState({
			catalog: [
				server("zeta", { official: true, category: "cloud", tags: ["Cloud"] }),
				server("alpha"),
				server("mid", { tagline: { en: "x", fr: "Base de données" } }),
			],
			installed: [{ id: "alpha" }] as never,
		});
	});

	const ids = () => store().getFilteredCatalog().map((s) => s.id);

	it("keeps the featured order until sorted by name", () => {
		expect(ids()).toEqual(["zeta", "alpha", "mid"]);
		store().setFilters({ sortBy: "name" });
		expect(ids()).toEqual(["alpha", "mid", "zeta"]);
	});

	it("searches names, both languages and tags", () => {
		store().setFilters({ search: "données" });
		expect(ids()).toEqual(["mid"]);
		store().setFilters({ search: "cloud" });
		expect(ids()).toEqual(["zeta"]);
		store().setFilters({ search: "ALPHA" });
		expect(ids()).toEqual(["alpha"]);
		store().setFilters({ search: "description zeta" });
		expect(ids()).toEqual(["zeta"]);
		store().setFilters({ search: "mid description" });
		expect(ids()).toEqual(["mid"]);
		store().setFilters({ search: "slogan alpha" });
		expect(ids()).toEqual(["alpha"]);
	});

	it("filters by category, installed and official", () => {
		store().setFilters({ category: "cloud" });
		expect(ids()).toEqual(["zeta"]);
		store().setFilters({ category: "all", showInstalledOnly: true });
		expect(ids()).toEqual(["alpha"]);
		store().setFilters({ showInstalledOnly: false, showOfficialOnly: true });
		expect(ids()).toEqual(["zeta"]);
	});

	it("switches tab", () => {
		store().setActiveTab("builder" as never);
		expect(store().activeTab).toBe("builder");
	});
});

describe("catalog and installed servers", () => {
	it("loads the catalog or says why it could not", async () => {
		api.invoke.mockResolvedValue({ success: true, data: [server("a")] });
		await loadMarketplaceCatalog();
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getCatalog");
		expect(store()).toMatchObject({ catalog: [{ id: "a" }], isCatalogLoading: false });
		api.invoke.mockResolvedValue({ success: false, error: "offline" });
		await loadMarketplaceCatalog();
		expect(store().error).toEqual({ key: "loadCatalog", detail: "offline" });
		api.invoke.mockResolvedValue(undefined);
		await loadMarketplaceCatalog();
		expect(store().error).toEqual({ key: "loadCatalog" });
		api.invoke.mockRejectedValue(new Error("ipc"));
		await loadMarketplaceCatalog();
		expect(store()).toMatchObject({ error: { key: "loadCatalog", detail: "ipc" }, isCatalogLoading: false });
		api.invoke.mockRejectedValue(1);
		await loadMarketplaceCatalog();
		expect(store().error).toEqual({ key: "loadCatalog" });
	});

	it("reads what the project installed", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: { customMcpServers: [{ id: "a" }], agentMcpOverrides: { coder: { add: ["a"] } } },
		});
		expect(await loadInstalledServers("p1")).toBe(true);
		expect(store()).toMatchObject({
			projectId: "p1",
			installed: [{ id: "a" }],
			agentOverrides: { coder: { add: ["a"] } },
			isInstalledLoading: false,
		});
		api.getProjectEnv.mockResolvedValue({ success: true, data: {} });
		await loadInstalledServers("p2");
		expect(store()).toMatchObject({ projectId: "p2", installed: [], agentOverrides: {} });
		api.getProjectEnv.mockResolvedValue({ success: false });
		await loadInstalledServers("p3");
		expect(store()).toMatchObject({ projectId: "p3", installed: [] });
		expect(await loadInstalledServers(null)).toBe(true);
		expect(store().projectId).toBeNull();
	});

	it("keeps what it had when the read fails, and says so", async () => {
		useMcpMarketplaceStore.setState({ projectId: "p1", installed: [{ id: "a" }] as never });
		api.getProjectEnv.mockRejectedValue(new Error("disk"));
		expect(await loadInstalledServers("p2")).toBe(false);
		expect(store()).toMatchObject({
			projectId: "p1",
			installed: [{ id: "a" }],
			isInstalledLoading: false,
			error: { key: "readSettings", detail: "disk" },
		});
	});

	it("drops the answer of a project the person has left", async () => {
		let answerA: (value: unknown) => void = () => undefined;
		api.getProjectEnv.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
		api.getProjectEnv.mockResolvedValueOnce({ success: true, data: { customMcpServers: [{ id: "b" }] } });
		const readA = loadInstalledServers("pA");
		expect(await loadInstalledServers("pB")).toBe(true);
		answerA({ success: true, data: { customMcpServers: [{ id: "a" }] } });
		expect(await readA).toBe(false);
		expect(store()).toMatchObject({ projectId: "pB", installed: [{ id: "b" }], isInstalledLoading: false });
	});

	it("drops a failed read of a project the person has left", async () => {
		let failA: (reason: unknown) => void = () => undefined;
		api.getProjectEnv.mockReturnValueOnce(new Promise((_, reject) => (failA = reject)));
		const readA = loadInstalledServers("pA");
		expect(store().isInstalledLoading).toBe(true);
		expect(await loadInstalledServers(null)).toBe(true);
		expect(store().isInstalledLoading).toBe(false);
		failA(new Error("disk"));
		expect(await readA).toBe(false);
		expect(store()).toMatchObject({ projectId: null, error: null, isInstalledLoading: false });
	});
});

describe("install and uninstall", () => {
	beforeEach(() => {
		useMcpMarketplaceStore.setState({ catalog: [server("db")] });
		api.updateProjectEnv.mockResolvedValue({ success: true });
	});

	it("writes the server and adds it to the chosen agents", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: { customMcpServers: [{ id: "other" }], agentMcpOverrides: {} },
		});
		expect(await installMarketplaceServer("p1", "db", { TOKEN: " t0k " }, ["coder"], "fr")).toBe(true);
		const written = api.updateProjectEnv.mock.calls[0];
		expect(written[0]).toBe("p1");
		expect(written[1].customMcpServers).toEqual([
			{ id: "other" },
			{
				id: "db",
				name: "DB",
				description: "slogan db",
				type: "command",
				command: "npx",
				args: ["-y", "@acme/db"],
				env: { TOKEN: "t0k" },
			},
		]);
		expect(written[1].agentMcpOverrides).toEqual({ coder: { add: ["db"], remove: [] } });
		expect(store().installed.map((s) => s.id)).toEqual(["other", "db"]);
		expect(store().isInstalling).toBeNull();
	});

	it("refuses an unknown server, a missing value or a second install", async () => {
		expect(await installMarketplaceServer("p1", "nope", {}, [])).toBe(false);
		expect(store().error).toEqual({ key: "unknownServer", name: "nope" });
		expect(await installMarketplaceServer("p1", "db", { TOKEN: " " }, [])).toBe(false);
		expect(store().error).toEqual({ key: "missingValues", name: "TOKEN" });
		api.getProjectEnv.mockResolvedValue({ success: true, data: { customMcpServers: [{ id: "db" }] } });
		expect(await installMarketplaceServer("p1", "db", { TOKEN: "t" }, [])).toBe(false);
		expect(store().error).toEqual({ key: "alreadyInstalled", name: "DB" });
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});

	it("does not write over the project's servers when they could not be read", async () => {
		useMcpMarketplaceStore.setState({ projectId: "p0", installed: [{ id: "from-p0" }] as never });
		api.getProjectEnv.mockRejectedValue(new Error("disk"));
		expect(await installMarketplaceServer("p1", "db", { TOKEN: "t" }, ["coder"])).toBe(false);
		expect(store().error).toEqual({ key: "readSettings", detail: "disk" });
		expect(await uninstallMarketplaceServer("p1", "x")).toBe(false);
		expect(store().error).toEqual({ key: "readSettings", detail: "disk" });
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});

	it("refuses to write when the project was left during the read", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.getProjectEnv.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const install = installMarketplaceServer("p1", "db", { TOKEN: "t" }, ["coder"]);
		await loadInstalledServers(null);
		answer({ success: true, data: {} });
		expect(await install).toBe(false);
		expect(store().error).toEqual({ key: "readSettings" });
		api.getProjectEnv.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const uninstall = uninstallMarketplaceServer("p1", "db");
		await loadInstalledServers(null);
		answer({ success: true, data: {} });
		expect(await uninstall).toBe(false);
		expect(store().error).toEqual({ key: "readSettings" });
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});

	it("reports a refused or failed write", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: {} });
		api.updateProjectEnv.mockResolvedValue({ success: false, error: "read-only" });
		expect(await installMarketplaceServer("p1", "db", { TOKEN: "t" }, [])).toBe(false);
		expect(store().error).toEqual({ key: "saveSettings", detail: "read-only" });
		api.updateProjectEnv.mockResolvedValue(undefined);
		expect(await installMarketplaceServer("p1", "db", { TOKEN: "t" }, [])).toBe(false);
		expect(store().error).toEqual({ key: "saveSettings" });
		api.updateProjectEnv.mockRejectedValue(new Error("ipc"));
		expect(await installMarketplaceServer("p1", "db", { TOKEN: "t" }, [])).toBe(false);
		expect(store()).toMatchObject({ error: { key: "install", detail: "ipc" }, isInstalling: null });
		api.updateProjectEnv.mockRejectedValue(1);
		await installMarketplaceServer("p1", "db", { TOKEN: "t" }, []);
		expect(store().error).toEqual({ key: "install" });
		expect(await uninstallMarketplaceServer("p1", "db")).toBe(false);
		expect(store().error).toEqual({ key: "uninstall" });
	});

	it("removes the server from the project and every agent", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: {
				customMcpServers: [{ id: "db" }, { id: "keep" }],
				agentMcpOverrides: { coder: { add: ["db", "keep"] }, qa: { remove: ["db"] } },
			},
		});
		expect(await uninstallMarketplaceServer("p1", "db")).toBe(true);
		expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", {
			customMcpServers: [{ id: "keep" }],
			agentMcpOverrides: { coder: { add: ["keep"], remove: [] }, qa: { add: [], remove: [] } },
		});
		expect(store().installed).toEqual([{ id: "keep" }]);
	});
});

describe("builder projects", () => {
	it("loads them, keeping the list when the read fails", async () => {
		api.invoke.mockResolvedValue({ success: true, data: [{ id: "b1" }] });
		await loadBuilderProjects();
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:getBuilderProjects");
		expect(store()).toMatchObject({ builderProjects: [{ id: "b1" }], isBuilderLoading: false });
		api.invoke.mockResolvedValue({ success: false, error: "locked" });
		await loadBuilderProjects();
		expect(store().error).toEqual({ key: "loadBuilder", detail: "locked" });
		api.invoke.mockRejectedValue(new Error("x"));
		await loadBuilderProjects();
		expect(store()).toMatchObject({
			builderProjects: [{ id: "b1" }],
			isBuilderLoading: false,
			error: { key: "loadBuilder", detail: "x" },
		});
	});

	it("adds a new project, updates a known one and deletes", async () => {
		api.invoke.mockResolvedValue({ success: true });
		expect(await saveBuilderProject({ id: "b1", name: "One" } as never)).toBe(true);
		expect(await saveBuilderProject({ id: "b2", name: "Two" } as never)).toBe(true);
		expect(await saveBuilderProject({ id: "b1", name: "Renamed" } as never)).toBe(true);
		expect(api.invoke).toHaveBeenCalledWith("mcpMarketplace:saveBuilder", { id: "b1", name: "One" });
		expect(store().builderProjects).toEqual([
			{ id: "b1", name: "Renamed" },
			{ id: "b2", name: "Two" },
		]);
		expect(await deleteBuilderProject("b1")).toBe(true);
		expect(api.invoke).toHaveBeenLastCalledWith("mcpMarketplace:deleteBuilder", { projectId: "b1" });
		expect(store().builderProjects.map((p) => p.id)).toEqual(["b2"]);
	});

	it("says when saving or deleting did not work", async () => {
		api.invoke.mockResolvedValue({ success: false });
		expect(await saveBuilderProject({ id: "b" } as never)).toBe(false);
		expect(store().error).toEqual({ key: "saveBuilder" });
		expect(await deleteBuilderProject("b")).toBe(false);
		expect(store().error).toEqual({ key: "deleteBuilder" });
		api.invoke.mockRejectedValue(new Error("x"));
		expect(await saveBuilderProject({ id: "b" } as never)).toBe(false);
		expect(store().error).toEqual({ key: "saveBuilder", detail: "x" });
		expect(await deleteBuilderProject("b")).toBe(false);
		expect(store().error).toEqual({ key: "deleteBuilder", detail: "x" });
		expect(store().builderProjects).toEqual([]);
	});

	it("keeps the loading flags and the list it is given", () => {
		store().setBuilderProjects([{ id: "x" }] as never);
		store().setIsInstalling("db");
		expect(store()).toMatchObject({ builderProjects: [{ id: "x" }], isInstalling: "db" });
	});
});
