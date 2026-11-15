/**
 * Importing Linear issues: teams, then a team's projects and issues, search
 * and state filters, selection, the import itself, and the answers that come
 * back late for a choice already replaced.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLinearImportModal } from "../useLinearImportModal";
import { useLinearIssues } from "../useLinearIssues";
import { useLinearProjects } from "../useLinearProjects";
import { useLinearTeams } from "../useLinearTeams";

const ok = <T>(data: T) => ({ success: true, data });
const issue = (id: string, type: string, title = id, description?: string) =>
	({ id, identifier: `ENG-${id}`, title, description, state: { id: type, name: type, type } }) as never;

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	api = {
		getLinearTeams: vi.fn().mockResolvedValue(ok([{ id: "t1", name: "Core" }])),
		getLinearProjects: vi.fn().mockResolvedValue(ok([{ id: "pr1", name: "Q4" }])),
		getLinearIssues: vi.fn().mockResolvedValue(
			ok([issue("1", "started", "Login crash", "token expired"), issue("2", "backlog", "Docs"), issue("3", "started")]),
		),
		importLinearIssues: vi.fn().mockResolvedValue(ok({ success: true, imported: 2, failed: 0 })),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

function deferred() {
	let resolve: (value: unknown) => void = vi.fn();
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
}

async function opened(onImportComplete = vi.fn()) {
	const hook = renderHook(() => useLinearImportModal({ projectId: "p1", open: true, onImportComplete }));
	await waitFor(() => expect(hook.result.current.issues).toHaveLength(3));
	return { ...hook, onImportComplete };
}

describe("the import modal", () => {
	it("picks the only team, then loads its projects and issues", async () => {
		const { result } = await opened();
		expect(result.current).toMatchObject({ selectedTeamId: "t1", projects: [{ id: "pr1" }], error: null });
		expect(api.getLinearProjects).toHaveBeenCalledWith("p1", "t1");
		expect(api.getLinearIssues).toHaveBeenCalledWith("p1", "t1", undefined);
		expect(result.current.uniqueStateTypes).toEqual(["started", "backlog"]);
	});

	it("waits for a choice when there are several teams, and loads nothing while closed", async () => {
		api.getLinearTeams.mockResolvedValue(ok([{ id: "t1" }, { id: "t2" }]));
		const closed = renderHook(() => useLinearImportModal({ projectId: "p1", open: false }));
		expect(api.getLinearTeams).not.toHaveBeenCalled();
		closed.unmount();

		const { result } = renderHook(() => useLinearImportModal({ projectId: "p1", open: true }));
		await waitFor(() => expect(result.current.teams).toHaveLength(2));
		expect(result.current.selectedTeamId).toBe("");
		expect(api.getLinearIssues).not.toHaveBeenCalled();
	});

	it("drops the project when another team is chosen", async () => {
		const { result } = await opened();
		act(() => result.current.setSelectedProjectId("pr1"));
		await waitFor(() => expect(api.getLinearIssues).toHaveBeenLastCalledWith("p1", "t1", "pr1"));
		act(() => result.current.setSelectedTeamId("t2"));
		expect(result.current.selectedProjectId).toBe("");
		await waitFor(() => expect(api.getLinearIssues).toHaveBeenLastCalledWith("p1", "t2", undefined));
	});

	it("searches the title, the identifier and the description, and filters by state", async () => {
		const { result } = await opened();
		act(() => result.current.setSearchQuery("TOKEN"));
		expect(result.current.issues.map((i) => i.id)).toEqual(["1"]);
		act(() => result.current.setSearchQuery("eng-2"));
		expect(result.current.issues.map((i) => i.id)).toEqual(["2"]);
		act(() => result.current.setSearchQuery("nothing"));
		expect(result.current.issues).toEqual([]);
		act(() => {
			result.current.setSearchQuery("");
			result.current.setFilterState("started");
		});
		expect(result.current.issues.map((i) => i.id)).toEqual(["1", "3"]);
	});

	it("selects issues one by one or all of the shown ones", async () => {
		const { result } = await opened();
		const controls = () => result.current.selectionControls;
		expect([controls().isAllSelected, controls().isSomeSelected]).toEqual([false, false]);
		act(() => controls().toggleIssue("1"));
		expect([controls().isAllSelected, controls().isSomeSelected]).toEqual([false, true]);
		act(() => controls().toggleIssue("1"));
		expect(result.current.selectedIssueIds.size).toBe(0);
		act(() => controls().selectAll());
		expect(controls().isAllSelected).toBe(true);
		act(() => controls().deselectAll());
		expect(result.current.selectedIssueIds.size).toBe(0);

		act(() => result.current.setSearchQuery("nothing"));
		expect(controls().isAllSelected).toBe(false);
	});

	it("imports the selected issues and reports a full import", async () => {
		const { result, onImportComplete } = await opened();
		await act(() => result.current.handleImport());
		expect(api.importLinearIssues).not.toHaveBeenCalled();

		act(() => result.current.selectionControls.toggleIssue("1"));
		act(() => result.current.selectionControls.toggleIssue("3"));
		await act(() => result.current.handleImport());
		expect(api.importLinearIssues).toHaveBeenCalledWith("p1", ["1", "3"]);
		expect(result.current).toMatchObject({ isImporting: false, importResult: { imported: 2 } });
		expect(onImportComplete).toHaveBeenCalledWith({ success: true, imported: 2, failed: 0 });

		api.importLinearIssues.mockResolvedValueOnce(ok({ success: false, imported: 1, failed: 1 }));
		await act(() => result.current.handleImport());
		expect(result.current.importResult).toMatchObject({ failed: 1 });
		expect(onImportComplete).toHaveBeenCalledOnce();
	});

	it("shows why an import failed, before the loading errors", async () => {
		const { result } = await opened();
		act(() => result.current.selectionControls.selectAll());
		api.importLinearIssues.mockResolvedValueOnce({ success: false, error: "quota" });
		await act(() => result.current.handleImport());
		expect(result.current.error).toBe("quota");

		api.importLinearIssues.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleImport());
		expect(result.current.error).toBe("Failed to import issues");

		api.importLinearIssues.mockRejectedValueOnce(new Error("offline"));
		await act(() => result.current.handleImport());
		expect(result.current.error).toBe("offline");

		api.importLinearIssues.mockRejectedValueOnce("x");
		await act(() => result.current.handleImport());
		expect(result.current.error).toBe("Unknown error");

		act(() => result.current.setError(null));
		expect(result.current.error).toBeNull();
	});

	it("reloads the team's issues on refresh, and starts over on reset", async () => {
		const { result } = await opened();
		api.getLinearIssues.mockClear();
		act(() => result.current.selectionControls.toggleIssue("1"));
		act(() => result.current.handleRefresh());
		await waitFor(() => expect(api.getLinearIssues).toHaveBeenCalledWith("p1", "t1", undefined));
		await waitFor(() => expect(result.current.selectedIssueIds.size).toBe(0));

		act(() => {
			result.current.setSearchQuery("x");
			result.current.setFilterState("started");
			result.current.resetState();
		});
		expect(result.current).toMatchObject({ searchQuery: "", filterState: "all", selectedProjectId: "" });
	});
});

describe("loading errors", () => {
	it.each([
		["teams", "getLinearTeams", "Failed to load teams"],
		["projects", "getLinearProjects", "Failed to load projects"],
		["issues", "getLinearIssues", "Failed to load issues"],
	])("shows why the %s could not be read", async (_what, method, fallback) => {
		api[method].mockResolvedValue({ success: false, error: "401" });
		const first = renderHook(() => useLinearImportModal({ projectId: "p1", open: true }));
		await waitFor(() => expect(first.result.current.error).toBe("401"));
		first.unmount();

		api[method].mockResolvedValue({ success: false });
		const second = renderHook(() => useLinearImportModal({ projectId: "p1", open: true }));
		await waitFor(() => expect(second.result.current.error).toBe(fallback));
		second.unmount();

		api[method].mockRejectedValue(new Error("ENOTFOUND"));
		const third = renderHook(() => useLinearImportModal({ projectId: "p1", open: true }));
		await waitFor(() => expect(third.result.current.error).toBe("ENOTFOUND"));
		third.unmount();

		api[method].mockRejectedValue(0);
		const fourth = renderHook(() => useLinearImportModal({ projectId: "p1", open: true }));
		await waitFor(() => expect(fourth.result.current.error).toBe("Unknown error"));
	});
});

describe("late answers", () => {
	it("keeps the issues of the team chosen last", async () => {
		const slow = deferred();
		api.getLinearIssues.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(ok([issue("b", "started")]));
		const changed = vi.fn();
		const { result, rerender } = renderHook(({ team }) => useLinearIssues("p1", team, "", changed), {
			initialProps: { team: "a" },
		});
		rerender({ team: "b" });
		await waitFor(() => expect(result.current.issues.map((i) => i.id)).toEqual(["b"]));
		await act(async () => slow.resolve(ok([issue("a", "started")])));
		expect(result.current).toMatchObject({ issues: [{ id: "b" }], isLoadingIssues: false });
		expect(changed).toHaveBeenCalledOnce();
	});

	it("keeps the projects of the team chosen last, and stops loading when no team is chosen", async () => {
		const slow = deferred();
		api.getLinearProjects.mockReturnValueOnce(slow.promise);
		const { result, rerender } = renderHook(({ team }) => useLinearProjects("p1", team), {
			initialProps: { team: "a" },
		});
		expect(result.current.isLoadingProjects).toBe(true);
		rerender({ team: "" });
		expect(result.current).toMatchObject({ projects: [], isLoadingProjects: false });
		await act(async () => slow.resolve(ok([{ id: "late" }])));
		expect(result.current.projects).toEqual([]);

		const failing = deferred();
		api.getLinearProjects.mockReturnValueOnce(failing.promise);
		rerender({ team: "c" });
		rerender({ team: "" });
		await act(async () => failing.resolve({ success: false, error: "late" }));
		expect(result.current.error).toBeNull();
	});

	it("ignores teams that arrive after the modal closed", async () => {
		const slow = deferred();
		api.getLinearTeams.mockReturnValueOnce(slow.promise);
		const { result, rerender } = renderHook(({ open }) => useLinearTeams("p1", open), { initialProps: { open: true } });
		rerender({ open: false });
		expect(result.current.isLoadingTeams).toBe(false);
		await act(async () => slow.resolve(ok([{ id: "t" }])));
		expect(result.current.teams).toEqual([]);

		const failing = deferred();
		api.getLinearTeams.mockReturnValueOnce(failing.promise);
		rerender({ open: true });
		rerender({ open: false });
		await act(async () => {
			failing.resolve(Promise.reject(new Error("late")));
		});
		expect(result.current.error).toBeNull();
	});
});
