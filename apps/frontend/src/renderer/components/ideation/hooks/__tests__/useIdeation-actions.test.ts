/**
 * What the ideation page does with ideas, on the real ideation store: the
 * actions that wait for a token, the types still worth adding, converting one
 * idea or a selection to tasks, dismissing, and which ideas are shown.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
	loadIdeation: vi.fn(),
	generateIdeation: vi.fn(),
	refreshIdeation: vi.fn(),
	appendIdeation: vi.fn(),
	stopIdeation: vi.fn(),
	dismissAllIdeasForProject: vi.fn(),
	deleteMultipleIdeasForProject: vi.fn(),
}));
const auth = vi.hoisted(() => ({ hasToken: true as boolean | null, isLoading: false, checkAuth: vi.fn() }));
const loadTasks = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../../../../stores/ideation-store", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...actions,
}));
vi.mock("../useIdeationAuth", () => ({ useIdeationAuth: () => auth }));
vi.mock("../../../../stores/task-store", () => ({ loadTasks }));
vi.mock("../../../../hooks/use-toast", () => ({ toast }));

import { useIdeationStore } from "../../../../stores/ideation-store";
import { ALL_IDEATION_TYPES } from "../../constants";
import { useIdeation } from "../useIdeation";

const idea = (id: string, type: string, status = "draft") => ({ id, type, status, title: id }) as never;
const INITIAL = useIdeationStore.getState();
let api: Record<string, ReturnType<typeof vi.fn>>;

function withIdeas(ideas: unknown[]) {
	useIdeationStore.setState({ session: { id: "s", projectId: "p1", ideas } as never });
}

beforeEach(() => {
	useIdeationStore.setState(INITIAL, true);
	for (const fn of [...Object.values(actions), auth.checkAuth, loadTasks, toast]) fn.mockReset();
	auth.hasToken = true;
	api = {
		convertIdeaToTask: vi.fn().mockResolvedValue({ success: true, data: { id: "task-1" } }),
		dismissIdea: vi.fn().mockResolvedValue({ success: true }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

const mounted = (options?: Parameters<typeof useIdeation>[1]) => renderHook(() => useIdeation("p1", options)).result;

describe("generation", () => {
	it("loads the session and runs, refreshes, stops and dismisses for the project", async () => {
		const result = mounted();
		expect(actions.loadIdeation).toHaveBeenCalledWith("p1");
		await act(() => result.current.handleGenerate());
		await act(() => result.current.handleRefresh());
		await act(() => result.current.handleStop());
		await act(() => result.current.handleDismissAll());
		expect(actions.generateIdeation).toHaveBeenCalledWith("p1");
		expect(actions.refreshIdeation).toHaveBeenCalledWith("p1");
		expect(actions.stopIdeation).toHaveBeenCalledWith("p1");
		expect(actions.dismissAllIdeasForProject).toHaveBeenCalledWith("p1");
	});

	it.each([
		["generate", "handleGenerate", "generateIdeation"],
		["refresh", "handleRefresh", "refreshIdeation"],
	] as const)("asks for a token, then runs %s once it is set", async (_name, handler, action) => {
		auth.hasToken = false;
		const result = mounted();
		await act(() => result.current[handler]());
		expect(actions[action]).not.toHaveBeenCalled();
		expect(result.current.showEnvConfigModal).toBe(true);

		act(() => result.current.handleEnvConfigured());
		expect(auth.checkAuth).toHaveBeenCalled();
		expect(actions[action]).toHaveBeenCalledWith("p1");
		act(() => result.current.handleEnvConfigured());
		expect(actions[action]).toHaveBeenCalledOnce();
	});

	it("adds the chosen types, waiting for a token when there is none", () => {
		const result = mounted();
		act(() => result.current.handleAddMoreIdeas());
		expect(actions.appendIdeation).not.toHaveBeenCalled();

		act(() => result.current.setShowAddMoreDialog(true));
		act(() => result.current.toggleTypeToAdd("security_hardening" as never));
		act(() => result.current.toggleTypeToAdd("code_quality" as never));
		act(() => result.current.toggleTypeToAdd("code_quality" as never));
		act(() => result.current.handleAddMoreIdeas());
		expect(actions.appendIdeation).toHaveBeenCalledWith("p1", ["security_hardening"]);
		expect(result.current).toMatchObject({ typesToAdd: [], showAddMoreDialog: false });

		auth.hasToken = false;
		act(() => result.current.toggleTypeToAdd("code_quality" as never));
		act(() => result.current.handleAddMoreIdeas());
		expect(actions.appendIdeation).toHaveBeenCalledOnce();
		expect(result.current.showEnvConfigModal).toBe(true);
		act(() => result.current.handleEnvConfigured());
		expect(actions.appendIdeation).toHaveBeenLastCalledWith("p1", ["code_quality"]);
		expect(result.current.typesToAdd).toEqual([]);
	});

	it("offers every type without a session, and only types with no active idea after", () => {
		expect(mounted().current.getAvailableTypesToAdd()).toEqual(ALL_IDEATION_TYPES);
		withIdeas([idea("a", "code_quality"), idea("b", "security_hardening", "dismissed"), idea("c", "ui_ux_improvements", "archived")]);
		const types = mounted().current.getAvailableTypesToAdd();
		expect(types).not.toContain("code_quality");
		expect(types).toContain("security_hardening");
		expect(types).toContain("ui_ux_improvements");
	});

	it("keeps at least one enabled type", () => {
		useIdeationStore.setState({ config: { ...INITIAL.config, enabledTypes: ["code_quality"] } });
		const result = mounted();
		act(() => result.current.toggleIdeationType("code_quality" as never));
		expect(useIdeationStore.getState().config.enabledTypes).toEqual(["code_quality"]);
		act(() => result.current.toggleIdeationType("security_hardening" as never));
		expect(useIdeationStore.getState().config.enabledTypes).toEqual(["code_quality", "security_hardening"]);
		act(() => result.current.toggleIdeationType("code_quality" as never));
		expect(useIdeationStore.getState().config.enabledTypes).toEqual(["security_hardening"]);
	});
});

describe("converting ideas", () => {
	it("turns an idea into a task once, even on a double click", async () => {
		withIdeas([idea("a", "code_quality")]);
		const result = mounted();
		await act(async () => {
			await Promise.all([result.current.handleConvertToTask(idea("a", "code_quality")), result.current.handleConvertToTask(idea("a", "code_quality"))]);
		});
		expect(api.convertIdeaToTask).toHaveBeenCalledOnce();
		expect(useIdeationStore.getState().session?.ideas[0]).toMatchObject({ taskId: "task-1", status: "archived" });
		expect(loadTasks).toHaveBeenCalledWith("p1");
		expect(result.current.convertingIdeas.size).toBe(0);
	});

	it("says why a conversion failed", async () => {
		vi.spyOn(console, "error").mockReturnValue(undefined);
		const result = mounted();
		api.convertIdeaToTask.mockResolvedValueOnce({ success: false, error: "already converted" });
		await act(() => result.current.handleConvertToTask(idea("a", "code_quality")));
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "destructive", description: "already converted" }));

		api.convertIdeaToTask.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleConvertToTask(idea("a", "code_quality")));
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "Failed to convert idea to task" }));

		api.convertIdeaToTask.mockRejectedValueOnce(new Error("ipc"));
		await act(() => result.current.handleConvertToTask(idea("a", "code_quality")));
		expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Conversion error" }));
		expect(result.current.convertingIdeas.size).toBe(0);
		expect(loadTasks).not.toHaveBeenCalled();
	});

	it("converts the selected open ideas and says how many became tasks", async () => {
		withIdeas([
			idea("a", "code_quality"),
			idea("b", "code_quality", "converted"),
			idea("c", "code_quality", "dismissed"),
			idea("d", "code_quality", "archived"),
			idea("e", "code_quality"),
		]);
		const result = mounted();
		act(() => result.current.handleSelectAll([idea("a", "x"), idea("b", "x"), idea("c", "x"), idea("d", "x"), idea("e", "x")]));
		await act(() => result.current.handleConvertSelectedToTasks());
		expect(api.convertIdeaToTask.mock.calls).toEqual([
			["p1", "a"],
			["p1", "e"],
		]);
		expect(loadTasks).toHaveBeenCalledOnce();
		expect(useIdeationStore.getState().selectedIds.size).toBe(0);
		expect(toast).toHaveBeenCalledOnce();
		expect(toast).toHaveBeenCalledWith({ title: expect.stringContaining("2") });
	});

	it("says when some of the selected ideas could not be converted", async () => {
		vi.spyOn(console, "error").mockReturnValue(undefined);
		withIdeas([idea("a", "code_quality"), idea("b", "code_quality"), idea("c", "code_quality")]);
		const result = mounted();
		act(() => result.current.toggleSelectIdea("a"));
		act(() => result.current.toggleSelectIdea("b"));
		act(() => result.current.toggleSelectIdea("c"));
		api.convertIdeaToTask
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("ipc"))
			.mockResolvedValueOnce({ success: true, data: { id: "t" } });
		await act(() => result.current.handleConvertSelectedToTasks());
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive", title: "Conversion failed" }));
		expect(loadTasks).toHaveBeenCalledOnce();

		toast.mockClear();
		loadTasks.mockClear();
		act(() => result.current.handleSelectAll([idea("a", "x")]));
		api.convertIdeaToTask.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleConvertSelectedToTasks());
		expect(toast).toHaveBeenCalledOnce();
		expect(loadTasks).not.toHaveBeenCalled();
		expect(useIdeationStore.getState().selectedIds.size).toBe(1);
	});

	it("converts nothing without a selection, a session, or an open idea in it", async () => {
		const result = mounted();
		await act(() => result.current.handleConvertSelectedToTasks());
		act(() => result.current.toggleSelectIdea("a"));
		await act(() => result.current.handleConvertSelectedToTasks());
		withIdeas([idea("a", "code_quality", "converted")]);
		await act(() => result.current.handleConvertSelectedToTasks());
		expect(api.convertIdeaToTask).not.toHaveBeenCalled();
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("other actions", () => {
	it("deletes the selected ideas, and nothing without a selection", async () => {
		const result = mounted();
		await act(() => result.current.handleDeleteSelected());
		expect(actions.deleteMultipleIdeasForProject).not.toHaveBeenCalled();
		act(() => result.current.toggleSelectIdea("a"));
		await act(() => result.current.handleDeleteSelected());
		expect(actions.deleteMultipleIdeasForProject).toHaveBeenCalledWith("p1", ["a"]);
		act(() => result.current.clearSelection());
		expect(result.current.selectedIds.size).toBe(0);
	});

	it("dismisses an idea, and rereads the session when the dismissal is refused", async () => {
		withIdeas([idea("a", "code_quality")]);
		const result = mounted();
		await act(() => result.current.handleDismiss(idea("a", "code_quality")));
		expect(api.dismissIdea).toHaveBeenCalledWith("p1", "a");
		expect(useIdeationStore.getState().session?.ideas[0]).toMatchObject({ status: "dismissed" });

		actions.loadIdeation.mockClear();
		api.dismissIdea.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleDismiss(idea("a", "code_quality")));
		expect(actions.loadIdeation).toHaveBeenCalledWith("p1");
	});

	it("opens a task through the page, when the page can", () => {
		const onGoToTask = vi.fn();
		mounted({ onGoToTask }).current.handleGoToTask("t1");
		expect(onGoToTask).toHaveBeenCalledWith("t1");
		expect(() => mounted().current.handleGoToTask("t1")).not.toThrow();
	});
});

describe("shown ideas", () => {
	beforeEach(() =>
		withIdeas([idea("a", "code_quality"), idea("d", "code_quality", "dismissed"), idea("r", "security_hardening", "archived")]),
	);
	const ids = (ideas: Array<{ id: string }>) => ideas.map((i) => i.id);

	it("shows the active ideas, then the dismissed, the archived, or all", () => {
		const result = mounted();
		expect(ids(result.current.activeIdeas)).toEqual(["a"]);
		act(() => result.current.setShowDismissed(true));
		expect(ids(result.current.activeIdeas)).toEqual(["a", "d"]);
		act(() => result.current.setShowArchived(true));
		expect(ids(result.current.activeIdeas)).toEqual(["a", "d", "r"]);
		act(() => result.current.setShowDismissed(false));
		expect(ids(result.current.activeIdeas)).toEqual(["a", "r"]);
		expect(ids(result.current.archivedIdeas)).toEqual(["r"]);
		expect(ids(result.current.getIdeasByType("code_quality" as never))).toEqual(["a", "d"]);
	});

	it("follows the archive switch of the page when it has one", () => {
		const result = mounted({ showArchived: true });
		act(() => result.current.setShowArchived(false));
		expect(result.current.showArchived).toBe(true);
		expect(ids(result.current.activeIdeas)).toEqual(["a", "r"]);
	});

	it("shows nothing without a session", () => {
		useIdeationStore.setState({ session: null });
		expect(mounted().current.activeIdeas).toEqual([]);
	});
});
