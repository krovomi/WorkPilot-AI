/**
 * @vitest-environment jsdom
 *
 * The dialog's store: it lists the project's orchestrations, launches one
 * (create, then start), and follows the main process's updates for the
 * project on screen only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MultiRepoOrchestration } from "../../../shared/types";

const loadProjects = vi.hoisted(() => vi.fn());
vi.mock("../project-store", () => ({ loadProjects }));

import { setupMultiRepoListeners, useMultiRepoStore } from "../multi-repo-store";

function orchestration(id: string, projectId = "p1"): MultiRepoOrchestration {
	return {
		id,
		projectId,
		taskDescription: "Add auth",
		status: "pending",
		running: false,
		repos: [],
		dependencyGraph: { nodes: [], edges: [] },
		executionOrder: [],
		repoStates: [],
		breakingChanges: [],
		overallProgress: 0,
		createdAt: "",
		updatedAt: "",
	};
}

let emit: (o: MultiRepoOrchestration) => void = () => undefined;
const api = {
	listMultiRepoOrchestrations: vi.fn(),
	createMultiRepoOrchestration: vi.fn(),
	startMultiRepoOrchestration: vi.fn(),
	stopMultiRepoOrchestration: vi.fn(),
	onMultiRepoUpdated: (callback: (o: MultiRepoOrchestration) => void) => {
		emit = callback;
		return () => undefined;
	},
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true, configurable: true });

beforeEach(() => {
	vi.clearAllMocks();
	useMultiRepoStore.setState({
		isDialogOpen: false,
		view: "list",
		projectId: null,
		orchestrations: [],
		activeId: null,
		pickedRepos: [],
		taskDescription: "",
		busy: false,
		error: null,
	});
});

describe("multi-repo store", () => {
	it("opens on the list, or on the form when there is nothing yet", async () => {
		api.listMultiRepoOrchestrations.mockResolvedValueOnce({ success: true, data: [] });
		await useMultiRepoStore.getState().openDialog("p1");
		expect(useMultiRepoStore.getState()).toMatchObject({ isDialogOpen: true, view: "new" });

		api.listMultiRepoOrchestrations.mockResolvedValueOnce({
			success: true,
			data: [orchestration("001-a")],
		});
		await useMultiRepoStore.getState().openDialog("p1");
		expect(useMultiRepoStore.getState().view).toBe("list");
	});

	it("launches: creates with the picked paths, shows it, starts it", async () => {
		useMultiRepoStore.setState({ projectId: "p1", view: "new", taskDescription: " Add auth " });
		useMultiRepoStore.getState().toggleRepo({ path: "/r/api", name: "api" });
		useMultiRepoStore.getState().toggleRepo({ path: "/r/web", name: "web" });
		useMultiRepoStore.getState().toggleRepo({ path: "/r/web", name: "web" });
		useMultiRepoStore.getState().toggleRepo({ path: "/r/web", name: "web" });
		api.createMultiRepoOrchestration.mockResolvedValue({
			success: true,
			data: orchestration("001-add-auth"),
		});
		api.startMultiRepoOrchestration.mockResolvedValue({ success: true });

		await useMultiRepoStore.getState().launch();

		expect(api.createMultiRepoOrchestration).toHaveBeenCalledWith("p1", {
			repos: [{ localPath: "/r/api" }, { localPath: "/r/web" }],
			taskDescription: "Add auth",
		});
		expect(api.startMultiRepoOrchestration).toHaveBeenCalledWith("p1", "001-add-auth");
		expect(loadProjects).toHaveBeenCalled();
		expect(useMultiRepoStore.getState()).toMatchObject({
			view: "detail",
			activeId: "001-add-auth",
			pickedRepos: [],
			busy: false,
			error: null,
		});
	});

	it("keeps the form and shows the refusal when creation fails", async () => {
		useMultiRepoStore.setState({ projectId: "p1", view: "new", taskDescription: "t" });
		api.createMultiRepoOrchestration.mockResolvedValue({
			success: false,
			error: "errors.repoNotAllowed",
		});
		await useMultiRepoStore.getState().launch();
		expect(api.startMultiRepoOrchestration).not.toHaveBeenCalled();
		expect(useMultiRepoStore.getState()).toMatchObject({
			view: "new",
			error: "errors.repoNotAllowed",
			busy: false,
		});
	});

	it("follows updates of the project on screen, not of the others", () => {
		useMultiRepoStore.setState({ projectId: "p1", orchestrations: [orchestration("001-a")] });
		setupMultiRepoListeners();
		emit({ ...orchestration("001-a"), status: "executing", running: true });
		emit(orchestration("002-b"));
		emit(orchestration("009-other", "p2"));
		const { orchestrations } = useMultiRepoStore.getState();
		expect(orchestrations.map((o) => [o.id, o.status])).toEqual([
			["002-b", "pending"],
			["001-a", "executing"],
		]);
	});
});
