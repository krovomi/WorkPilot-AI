/**
 * The Plugin Marketplace store: how the catalog is searched, filtered and
 * sorted, which plugins a project has, and what installing or removing one
 * asks the main process and shows when it fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	InstalledPlugin,
	MarketplacePlugin,
} from "../../../shared/types/plugin-marketplace";
import {
	installPlugin,
	loadInstalledPlugins,
	loadPluginCatalog,
	uninstallPlugin,
	usePluginMarketplaceStore,
} from "../plugin-marketplace-store";

function plugin(over: Partial<MarketplacePlugin>): MarketplacePlugin {
	return {
		id: "p",
		name: "Plugin",
		type: "agent",
		author: "a",
		color: "#000",
		tags: [],
		tagline: { en: "", fr: "" },
		description: { en: "", fr: "" },
		skill: {} as MarketplacePlugin["skill"],
		...over,
	};
}

const REVIEWER = plugin({
	id: "reviewer",
	name: "Reviewer",
	tags: ["Quality"],
	tagline: { en: "Reviews code", fr: "Relit le code" },
});
const API_SPEC = plugin({
	id: "api-spec",
	name: "API spec",
	type: "spec-template",
	description: { en: "An OpenAPI template", fr: "Un modèle OpenAPI" },
});
const COMMIT = plugin({ id: "commit", name: "Commit", type: "custom-prompt" });
const installedOf = (id: string): InstalledPlugin => ({
	pluginId: id,
	name: id,
	type: "agent",
	paths: [`.agents/skills/${id}`],
});

const invoke = vi.fn();
const INITIAL = usePluginMarketplaceStore.getState();
const store = () => usePluginMarketplaceStore.getState();

beforeEach(() => {
	usePluginMarketplaceStore.setState(INITIAL, true);
	invoke.mockReset();
	(globalThis as unknown as { electronAPI: { invoke: typeof invoke } }).electronAPI = { invoke };
});

describe("catalog filters", () => {
	beforeEach(() => store().setCatalog([REVIEWER, API_SPEC, COMMIT]));

	it("keeps the catalog order when featured", () => {
		expect(store().getFilteredCatalog()).toEqual([REVIEWER, API_SPEC, COMMIT]);
	});

	it.each([
		["name", "review", ["reviewer"]],
		["English tagline", "reviews CODE", ["reviewer"]],
		["French tagline", "relit", ["reviewer"]],
		["English description", "openapi", ["api-spec"]],
		["French description", "modèle", ["api-spec"]],
		["tag", "quality", ["reviewer"]],
		["nothing", "zzz", []],
	])("searches the %s", (_where, search, ids) => {
		store().setFilters({ search });
		expect(store().getFilteredCatalog().map((p) => p.id)).toEqual(ids);
	});

	it("filters by type and sorts by name", () => {
		store().setFilters({ type: "spec-template" });
		expect(store().getFilteredCatalog()).toEqual([API_SPEC]);
		store().setFilters({ type: "all", sortBy: "name" });
		expect(store().getFilteredCatalog().map((p) => p.id)).toEqual([
			"api-spec",
			"commit",
			"reviewer",
		]);
		expect(store().filters.search).toBe("");
	});

	it("shows only installed plugins on request", () => {
		store().setInstalled("proj", [installedOf("commit")]);
		store().setFilters({ showInstalledOnly: true });
		expect(store().getFilteredCatalog()).toEqual([COMMIT]);
		expect(store().isPluginInstalled("commit")).toBe(true);
		expect(store().isPluginInstalled("reviewer")).toBe(false);
	});

	it("switches tab", () => {
		store().setActiveTab("installed");
		expect(store().activeTab).toBe("installed");
	});
});

describe("loadPluginCatalog", () => {
	it("loads the catalog", async () => {
		invoke.mockResolvedValue({ success: true, data: [REVIEWER] });
		await loadPluginCatalog();
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:getCatalog");
		expect(store()).toMatchObject({ catalog: [REVIEWER], isCatalogLoading: false, error: null });
	});

	it("shows why the catalog could not be read", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "corrupt" });
		await loadPluginCatalog();
		expect(store()).toMatchObject({ error: "corrupt", isCatalogLoading: false });

		invoke.mockResolvedValueOnce(undefined);
		await loadPluginCatalog();
		expect(store().error).toBe("Failed to load catalog");

		invoke.mockRejectedValueOnce(new Error("down"));
		await loadPluginCatalog();
		expect(store().error).toBe("down");

		invoke.mockRejectedValueOnce("down");
		await loadPluginCatalog();
		expect(store()).toMatchObject({ error: "Failed to load catalog", isCatalogLoading: false });
	});
});

describe("loadInstalledPlugins", () => {
	it("reads the skills of the project", async () => {
		invoke.mockResolvedValue({ success: true, data: [installedOf("reviewer")] });
		await loadInstalledPlugins("proj");
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:getInstalled", { projectId: "proj" });
		expect(store()).toMatchObject({
			projectId: "proj",
			installed: [installedOf("reviewer")],
			isInstalledLoading: false,
		});
	});

	it("lists nothing without a project, or when the main process refuses, and says why", async () => {
		store().setInstalled("old", [installedOf("x")]);
		await loadInstalledPlugins(undefined);
		expect(store()).toMatchObject({ projectId: null, installed: [] });
		expect(invoke).not.toHaveBeenCalled();

		invoke.mockResolvedValueOnce({ success: false, error: "Unknown project" });
		await loadInstalledPlugins("proj");
		expect(store()).toMatchObject({ projectId: "proj", installed: [], error: "Unknown project" });

		invoke.mockResolvedValueOnce(undefined);
		await loadInstalledPlugins("proj");
		expect(store().error).toBe("Could not read the plugins installed in this project");
	});

	it("keeps the project's last list when the read throws, and says why", async () => {
		store().setInstalled("proj", [installedOf("x")]);
		invoke.mockRejectedValueOnce(new Error("down"));
		await loadInstalledPlugins("proj");
		expect(store()).toMatchObject({
			installed: [installedOf("x")],
			isInstalledLoading: false,
			error: "down",
		});

		// Another project's list is not this one's.
		invoke.mockRejectedValueOnce("down");
		await loadInstalledPlugins("other");
		expect(store()).toMatchObject({
			projectId: "other",
			installed: [],
			error: "Could not read the plugins installed in this project",
		});
	});

	it("applies only the answer of the last project asked for", async () => {
		const answers: Array<(v: unknown) => void> = [];
		const failures: Array<(e: unknown) => void> = [];
		invoke.mockImplementation(
			() =>
				new Promise((resolve, reject) => {
					answers.push(resolve);
					failures.push(reject);
				}),
		);
		const first = loadInstalledPlugins("first");
		const second = loadInstalledPlugins("second");
		answers[1]({ success: true, data: [installedOf("b")] });
		await second;
		answers[0]({ success: true, data: [installedOf("a")] });
		await first;
		expect(store()).toMatchObject({ projectId: "second", installed: [installedOf("b")] });

		// A late failure of an earlier read changes nothing either, and a read
		// that ends early does not stop the spinner of the one still running.
		const third = loadInstalledPlugins("third");
		const fourth = loadInstalledPlugins("fourth");
		failures[2](new Error("late"));
		await third;
		expect(store()).toMatchObject({ isInstalledLoading: true, error: null });
		answers[3]({ success: true, data: [] });
		await fourth;
		expect(store()).toMatchObject({ projectId: "fourth", isInstalledLoading: false });

		// Leaving every project while a read runs drops its answer.
		const fifth = loadInstalledPlugins("fifth");
		await loadInstalledPlugins(null);
		answers[4]({ success: true, data: [installedOf("e")] });
		await fifth;
		expect(store()).toMatchObject({ projectId: null, installed: [], isInstalledLoading: false });
	});
});

describe("installPlugin and uninstallPlugin", () => {
	it("installs into the project, then rereads its skills", async () => {
		invoke
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: true, data: [installedOf("reviewer")] });
		expect(await installPlugin("proj", "reviewer")).toBe(true);
		expect(invoke).toHaveBeenNthCalledWith(1, "pluginMarketplace:install", {
			projectId: "proj",
			pluginId: "reviewer",
		});
		expect(store()).toMatchObject({ installed: [installedOf("reviewer")], isInstalling: null });
	});

	it("shows why an install failed", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "exists" });
		expect(await installPlugin("proj", "reviewer")).toBe(false);
		expect(store()).toMatchObject({ error: "exists", isInstalling: null });

		invoke.mockResolvedValueOnce(undefined);
		expect(await installPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("Installation failed");

		invoke.mockRejectedValueOnce(new Error("disk full"));
		expect(await installPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("disk full");

		invoke.mockRejectedValueOnce("x");
		expect(await installPlugin("proj", "reviewer")).toBe(false);
		expect(store()).toMatchObject({ error: "Installation failed", isInstalling: null });
	});

	it("marks the plugin being installed while it installs", async () => {
		let finish: (v: unknown) => void = () => undefined;
		invoke.mockReturnValueOnce(new Promise((r) => (finish = r)));
		const pending = installPlugin("proj", "reviewer");
		expect(store().isInstalling).toBe("reviewer");
		finish({ success: false });
		await pending;
		expect(store().isInstalling).toBeNull();
	});

	it("removes a plugin, then rereads the project's skills", async () => {
		store().setInstalled("proj", [installedOf("reviewer")]);
		invoke
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: true, data: [] });
		expect(await uninstallPlugin("proj", "reviewer")).toBe(true);
		expect(invoke).toHaveBeenNthCalledWith(1, "pluginMarketplace:uninstall", {
			projectId: "proj",
			pluginId: "reviewer",
		});
		expect(store().installed).toEqual([]);
	});

	it("shows why a removal failed, thrown or answered", async () => {
		invoke.mockResolvedValueOnce({ success: false, error: "locked" });
		expect(await uninstallPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("locked");

		invoke.mockResolvedValueOnce(undefined);
		expect(await uninstallPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("Uninstall failed");

		invoke.mockRejectedValueOnce(new Error("EBUSY"));
		expect(await uninstallPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("EBUSY");

		invoke.mockRejectedValueOnce("x");
		expect(await uninstallPlugin("proj", "reviewer")).toBe(false);
		expect(store().error).toBe("Uninstall failed");
	});

	it("clears the last error when a removal succeeds", async () => {
		store().setError("old");
		invoke.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true, data: [] });
		await uninstallPlugin("proj", "reviewer");
		expect(store().error).toBeNull();
	});
});
