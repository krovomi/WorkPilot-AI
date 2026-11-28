/**
 * The project store's IPC side: loading the projects and the tab layout at
 * startup, adding, removing, renaming, repointing a project, the missing-path
 * flags, and the debounced save of the tabs.
 *
 * @vitest-environment jsdom
 */
import type { Project } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addProject,
	checkProjectVersion,
	initializeProject,
	loadProjects,
	refreshProjects,
	removeProject,
	renameProject,
	updateProjectSettings,
	useProjectStore,
} from "../project-store";

const project = (id: string, over: Partial<Project> = {}) =>
	({ id, name: id, path: `/repos/${id}`, settings: {}, ...over }) as unknown as Project;

const api = {
	getTabState: vi.fn(),
	getProjects: vi.fn(),
	saveTabState: vi.fn(),
	checkProjectPaths: vi.fn(),
	repathProject: vi.fn(),
	addProject: vi.fn(),
	removeProject: vi.fn(),
	renameProject: vi.fn(),
	updateProjectSettings: vi.fn(),
	initializeProject: vi.fn(),
	checkProjectVersion: vi.fn(),
};

const INITIAL = useProjectStore.getState();
const store = () => useProjectStore.getState();

beforeEach(() => {
	useProjectStore.setState({ ...INITIAL, missingPaths: new Set() }, true);
	localStorage.clear();
	for (const fn of Object.values(api)) fn.mockReset();
	api.saveTabState.mockResolvedValue({ success: true });
	api.checkProjectPaths.mockResolvedValue({ success: true, data: {} });
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("loadProjects", () => {
	it("restores the tabs and the projects, the active tab being the selected project", async () => {
		api.getTabState.mockResolvedValue({
			success: true,
			data: { openProjectIds: ["a", "b"], activeProjectId: "b", tabOrder: ["b", "a"] },
		});
		api.getProjects.mockResolvedValue({ success: true, data: [project("a"), project("b")] });
		// An older selection saved on this machine: the views showed project a
		// (its pull requests) under project b's tab.
		localStorage.setItem("lastSelectedProjectId", "a");
		await loadProjects();
		expect(store()).toMatchObject({
			openProjectIds: ["a", "b"],
			activeProjectId: "b",
			tabOrder: ["b", "a"],
			selectedProjectId: "b",
			isLoading: false,
			error: null,
		});
		expect(store().projects).toHaveLength(2);
		expect(api.checkProjectPaths).toHaveBeenCalled();
	});

	it("restores the last selected project when no tab is active", async () => {
		api.getTabState.mockResolvedValue({ success: true, data: { openProjectIds: [] } });
		api.getProjects.mockResolvedValue({ success: true, data: [project("a"), project("b")] });
		localStorage.setItem("lastSelectedProjectId", "a");
		await loadProjects();
		expect(store()).toMatchObject({ selectedProjectId: "a", activeProjectId: null });
	});

	it("falls back to the active tab when nothing was selected on this machine", async () => {
		api.getTabState.mockResolvedValue({ success: true, data: { activeProjectId: "b" } });
		api.getProjects.mockResolvedValue({ success: true, data: [project("b")] });
		await loadProjects();
		expect(store()).toMatchObject({ selectedProjectId: "b", openProjectIds: [], tabOrder: [] });
	});

	it("selects nothing when the remembered project is gone", async () => {
		api.getTabState.mockResolvedValue({ success: false });
		api.getProjects.mockResolvedValue({ success: true, data: [project("a")] });
		localStorage.setItem("lastSelectedProjectId", "gone");
		await loadProjects();
		expect(store().selectedProjectId).toBeNull();

		api.getTabState.mockResolvedValue({ success: true, data: { activeProjectId: "gone" } });
		localStorage.clear();
		await loadProjects();
		expect(store().selectedProjectId).toBeNull();

		api.getTabState.mockResolvedValue({ success: true, data: {} });
		await loadProjects();
		expect(store().selectedProjectId).toBeNull();
	});

	it("shows why the projects could not be read", async () => {
		api.getTabState.mockResolvedValue({ success: true });
		api.getProjects.mockResolvedValueOnce({ success: false, error: "corrupt store" });
		await loadProjects();
		expect(store()).toMatchObject({ error: "corrupt store", isLoading: false });

		api.getProjects.mockResolvedValueOnce({ success: false });
		await loadProjects();
		expect(store().error).toBe("Erreur lors du chargement des projets.");

		api.getProjects.mockResolvedValueOnce({ success: true });
		await loadProjects();
		expect(store().error).toBeNull();
	});

	it("explains an answer that is not JSON, from either call", async () => {
		api.getTabState.mockResolvedValueOnce("<html>");
		await loadProjects();
		expect(store().error).toMatch(/non-JSON/);

		api.getTabState.mockResolvedValue({ success: true });
		api.getProjects.mockResolvedValueOnce(null);
		await loadProjects();
		expect(store().error).toMatch(/non-JSON/);
		expect(store().isLoading).toBe(false);
	});

	it("names an HTML page or any other failure", async () => {
		api.getTabState.mockRejectedValueOnce(new Error("Unexpected token < in JSON"));
		await loadProjects();
		expect(store().error).toMatch(/HTML au lieu du JSON/);

		api.getTabState.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		await loadProjects();
		expect(store().error).toBe("ECONNREFUSED");

		api.getTabState.mockRejectedValueOnce({});
		await loadProjects();
		expect(store().error).toBe("Erreur inconnue lors du chargement des projets.");
	});
});

describe("refreshProjects", () => {
	it("rereads the projects without touching the selection or the tabs", async () => {
		useProjectStore.setState({ selectedProjectId: "a", openProjectIds: ["a"] });
		api.getProjects.mockResolvedValue({ success: true, data: [project("a", { name: "new" })] });
		expect(await refreshProjects()).toBe(true);
		expect(store()).toMatchObject({ selectedProjectId: "a", openProjectIds: ["a"] });
		expect(store().projects[0].name).toBe("new");
	});

	it("keeps the list when the read is refused or fails", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		api.getProjects.mockResolvedValueOnce({ success: false });
		expect(await refreshProjects()).toBe(false);
		api.getProjects.mockResolvedValueOnce(null);
		expect(await refreshProjects()).toBe(false);
		api.getProjects.mockRejectedValueOnce(new Error("down"));
		expect(await refreshProjects()).toBe(false);
		expect(store().projects).toEqual([project("a")]);
	});
});

describe("missing paths and repath", () => {
	it("flags the projects whose folder is gone", async () => {
		api.checkProjectPaths.mockResolvedValue({ success: true, data: { a: true, b: false } });
		await store().refreshMissingPaths();
		expect([...store().missingPaths]).toEqual(["b"]);
	});

	it("keeps the flags when the check is refused, fails or is unavailable", async () => {
		useProjectStore.setState({ missingPaths: new Set(["b"]) });
		api.checkProjectPaths.mockResolvedValueOnce({ success: false });
		await store().refreshMissingPaths();
		api.checkProjectPaths.mockRejectedValueOnce(new Error("down"));
		await store().refreshMissingPaths();
		(window as unknown as { electronAPI: unknown }).electronAPI = {};
		await store().refreshMissingPaths();
		expect([...store().missingPaths]).toEqual(["b"]);
	});

	it("repoints a project and clears its flag", async () => {
		useProjectStore.setState({ projects: [project("a"), project("b")], missingPaths: new Set(["a"]) });
		api.repathProject.mockResolvedValue({ success: true, data: { path: "/moved/a" } });
		expect(await store().repathProject("a", "/moved/a")).toBe(true);
		expect(api.repathProject).toHaveBeenCalledWith("a", "/moved/a");
		expect(store().projects.map((p) => p.path)).toEqual(["/moved/a", "/repos/b"]);
		expect(store().missingPaths.size).toBe(0);
	});

	it("changes nothing when the repath is refused, fails or is unavailable", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		api.repathProject.mockResolvedValueOnce({ success: false });
		expect(await store().repathProject("a", "/x")).toBe(false);
		api.repathProject.mockRejectedValueOnce(new Error("down"));
		expect(await store().repathProject("a", "/x")).toBe(false);
		(window as unknown as { electronAPI: unknown }).electronAPI = {};
		expect(await store().repathProject("a", "/x")).toBe(false);
		expect(store().projects[0].path).toBe("/repos/a");
	});
});

describe("adding and removing projects", () => {
	it("adds, selects and opens the new project, passing on the warning", async () => {
		api.addProject.mockResolvedValue({ success: true, data: project("n"), warning: "Git sub-folder" });
		expect(await addProject("/repos/n")).toEqual({ project: project("n"), warning: "Git sub-folder" });
		expect(store()).toMatchObject({ selectedProjectId: "n", activeProjectId: "n", openProjectIds: ["n"] });
	});

	it("shows why a project could not be added", async () => {
		api.addProject.mockResolvedValueOnce({ success: false, error: "Not a folder" });
		expect(await addProject("/x")).toBeNull();
		expect(store().error).toBe("Not a folder");
		api.addProject.mockResolvedValueOnce({ success: true });
		expect(await addProject("/x")).toBeNull();
		expect(store().error).toBe("Failed to add project");
		api.addProject.mockRejectedValueOnce(new Error("EACCES"));
		expect(await addProject("/x")).toBeNull();
		expect(store().error).toBe("EACCES");
		api.addProject.mockRejectedValueOnce("x");
		expect(await addProject("/x")).toBeNull();
		expect(store().error).toBe("Unknown error");
	});

	it("removes a project and closes its tab", async () => {
		useProjectStore.setState({ projects: [project("a"), project("b")], openProjectIds: ["a", "b"], tabOrder: ["a", "b"] });
		api.removeProject.mockResolvedValue({ success: true });
		expect(await removeProject("a")).toBe(true);
		expect(store().projects.map((p) => p.id)).toEqual(["b"]);
		expect(store().openProjectIds).toEqual(["b"]);
	});

	it("removes a project that has no tab open without touching the others", async () => {
		useProjectStore.setState({ projects: [project("a"), project("b")], openProjectIds: ["b"], tabOrder: ["b"], activeProjectId: "b" });
		api.removeProject.mockResolvedValue({ success: true });
		expect(await removeProject("a")).toBe(true);
		expect(store()).toMatchObject({ openProjectIds: ["b"], activeProjectId: "b" });
	});

	it("closes a tab opened while the removal was in flight", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		let answer: (v: unknown) => void = () => undefined;
		api.removeProject.mockReturnValueOnce(new Promise((r) => (answer = r)));
		const pending = removeProject("a");
		store().openProjectTab("a");
		answer({ success: true });
		expect(await pending).toBe(true);
		expect(store().openProjectIds).toEqual([]);
	});

	it("keeps a project the main process would not remove", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		api.removeProject.mockResolvedValueOnce({ success: false });
		expect(await removeProject("a")).toBe(false);
		api.removeProject.mockRejectedValueOnce(new Error("down"));
		expect(await removeProject("a")).toBe(false);
		expect(store().projects).toHaveLength(1);
	});
});

describe("renameProject", () => {
	it("renames with the trimmed name", async () => {
		useProjectStore.setState({ projects: [project("a"), project("b")] });
		api.renameProject.mockResolvedValue({ success: true, data: project("a") });
		expect(await renameProject("a", "  Shop  ")).toBe(true);
		expect(api.renameProject).toHaveBeenCalledWith("a", "Shop");
		expect(store().projects.map((p) => p.name)).toEqual(["Shop", "b"]);
	});

	it("keeps a project added while the rename was in flight", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		let answer: (v: unknown) => void = () => undefined;
		api.renameProject.mockReturnValueOnce(new Promise((r) => (answer = r)));
		const pending = renameProject("a", "Shop");
		store().addProject(project("b"));
		answer({ success: true, data: project("a") });
		await pending;
		expect(store().projects.map((p) => p.name)).toEqual(["Shop", "b"]);
	});

	it("refuses an empty name and keeps the name when refused", async () => {
		useProjectStore.setState({ projects: [project("a")] });
		expect(await renameProject("a", "   ")).toBe(false);
		expect(api.renameProject).not.toHaveBeenCalled();
		api.renameProject.mockResolvedValueOnce({ success: false });
		expect(await renameProject("a", "x")).toBe(false);
		api.renameProject.mockRejectedValueOnce(new Error("down"));
		expect(await renameProject("a", "x")).toBe(false);
		expect(store().projects[0].name).toBe("a");
	});
});

describe("settings, initialization and version", () => {
	it("keeps the settings when the save is refused, and shows a thrown error", async () => {
		useProjectStore.setState({ projects: [project("a", { settings: { model: "m" } as never })] });
		api.updateProjectSettings.mockResolvedValueOnce({ success: false });
		expect(await updateProjectSettings("a", { model: "x" } as never)).toBe(false);
		expect(store().projects[0].settings).toEqual({ model: "m" });

		api.updateProjectSettings.mockRejectedValueOnce(new Error("EPERM"));
		expect(await updateProjectSettings("a", {})).toBe(false);
		expect(store().error).toBe("EPERM");
		api.updateProjectSettings.mockRejectedValueOnce("x");
		await updateProjectSettings("a", {});
		expect(store().error).toBe("Unknown error");
	});

	it("passes initialization and version answers through, and turns a throw into a refusal", async () => {
		api.initializeProject.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
		expect(await initializeProject("a")).toEqual({ success: true, data: { ok: 1 } });
		api.initializeProject.mockRejectedValueOnce(new Error("no git"));
		expect(await initializeProject("a")).toEqual({ success: false, error: "no git" });
		api.initializeProject.mockRejectedValueOnce("x");
		expect(await initializeProject("a")).toEqual({ success: false, error: "Unknown error" });

		api.checkProjectVersion.mockResolvedValueOnce({ success: true, data: { version: 2 } });
		expect(await checkProjectVersion("a")).toEqual({ success: true, data: { version: 2 } });
		api.checkProjectVersion.mockRejectedValueOnce(new Error("bad"));
		expect(await checkProjectVersion("a")).toEqual({ success: false, error: "bad" });
		api.checkProjectVersion.mockRejectedValueOnce(1);
		expect(await checkProjectVersion("a")).toEqual({ success: false, error: "Unknown error" });
	});
});

describe("tab state saved to the main process", () => {
	it("saves once, 100 ms after the last change", async () => {
		vi.useFakeTimers();
		store().openProjectTab("a");
		store().openProjectTab("b");
		store().reorderTabs(1, 0);
		expect(api.saveTabState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(api.saveTabState).toHaveBeenCalledOnce();
		expect(api.saveTabState).toHaveBeenCalledWith({
			openProjectIds: ["a", "b"],
			activeProjectId: "b",
			tabOrder: ["b", "a"],
		});
	});

	it("survives a refused save", async () => {
		vi.useFakeTimers();
		api.saveTabState.mockRejectedValue(new Error("down"));
		store().openProjectTab("a");
		await vi.advanceTimersByTimeAsync(100);
		expect(console.error).toHaveBeenCalledWith("[ProjectStore] Failed to save tab state:", expect.any(Error));
	});

	it("lists the tabs in their order, then any open project not in it", () => {
		useProjectStore.setState({
			projects: [project("a"), project("b"), project("c")],
			openProjectIds: ["a", "b", "c"],
			tabOrder: ["c", "a", "gone"],
		});
		expect(store().getProjectTabs().map((p) => p.id)).toEqual(["c", "a", "b"]);
	});
});
