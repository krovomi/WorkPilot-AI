/**
 * The GitLab issues page hooks: when issues load (once per change of filter
 * or connection, never twice), the selected issue, the search box, and the
 * investigation shown on the page.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forge = vi.hoisted(() => ({
	checkGitLabConnection: vi.fn(),
	loadGitLabIssues: vi.fn(),
	investigateGitLabIssue: vi.fn(),
}));
vi.mock("../../../../stores/gitlab-store", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...forge,
}));

import { useGitLabStore } from "../../../../stores/gitlab-store";
import { useGitLabInvestigation } from "../useGitLabInvestigation";
import { useGitLabIssues } from "../useGitLabIssues";
import { useIssueFiltering } from "../useIssueFiltering";

const issue = (iid: number, state: "opened" | "closed", title = `Issue ${iid}`, description?: string) =>
	({ iid, state, title, description }) as never;
const INITIAL = useGitLabStore.getState();

beforeEach(() => {
	for (const fn of Object.values(forge)) fn.mockReset();
	useGitLabStore.setState(INITIAL, true);
});

describe("useGitLabIssues", () => {
	it("checks the connection, then loads the issues once connected", () => {
		const { rerender } = renderHook(({ id }) => useGitLabIssues(id), { initialProps: { id: "p1" as string | undefined } });
		expect(forge.checkGitLabConnection).toHaveBeenCalledWith("p1");
		expect(forge.loadGitLabIssues).not.toHaveBeenCalled();
		act(() => useGitLabStore.setState({ syncStatus: { connected: true } as never }));
		expect(forge.loadGitLabIssues.mock.calls).toEqual([["p1", "opened"]]);

		rerender({ id: undefined });
		expect(forge.checkGitLabConnection).toHaveBeenCalledOnce();
	});

	it("loads once per filter change", () => {
		useGitLabStore.setState({ syncStatus: { connected: true } as never });
		const { result } = renderHook(() => useGitLabIssues("p1"));
		forge.loadGitLabIssues.mockClear();
		act(() => result.current.handleFilterChange("closed"));
		expect(forge.loadGitLabIssues.mock.calls).toEqual([["p1", "closed"]]);
		expect(result.current.filterState).toBe("closed");
	});

	it("refreshes the connection and the issues, only with a project", () => {
		const none = renderHook(() => useGitLabIssues(undefined));
		act(() => none.result.current.handleRefresh());
		expect(forge.checkGitLabConnection).not.toHaveBeenCalled();

		const { result } = renderHook(() => useGitLabIssues("p1"));
		forge.checkGitLabConnection.mockClear();
		act(() => result.current.handleRefresh());
		expect(forge.checkGitLabConnection).toHaveBeenCalledWith("p1");
		expect(forge.loadGitLabIssues).toHaveBeenCalledWith("p1", "opened");
	});

	it("reads the issues, the selection and the counts from the store", () => {
		useGitLabStore.setState({ issues: [issue(1, "opened"), issue(2, "closed")] });
		const { result } = renderHook(() => useGitLabIssues("p1"));
		expect(result.current.selectedIssue).toBeNull();
		act(() => result.current.selectIssue(2));
		expect(result.current).toMatchObject({ selectedIssueIid: 2, selectedIssue: issue(2, "closed") });
		expect(result.current.getFilteredIssues()).toEqual([issue(1, "opened")]);
		expect(result.current.getOpenIssuesCount()).toBe(1);
	});
});

describe("useIssueFiltering", () => {
	it("filters by title or description", () => {
		const issues = [issue(1, "opened", "Login crash", "token"), issue(2, "opened", "Docs")];
		const { result } = renderHook(() => useIssueFiltering(issues));
		expect(result.current.filteredIssues).toEqual(issues);
		act(() => result.current.setSearchQuery("TOKEN"));
		expect(result.current).toMatchObject({ searchQuery: "TOKEN", filteredIssues: [issues[0]] });
		act(() => result.current.setSearchQuery("docs"));
		expect(result.current.filteredIssues).toEqual([issues[1]]);
	});
});

describe("useGitLabInvestigation", () => {
	it("starts an investigation of the issue with the chosen notes, and resets the status", () => {
		const { result } = renderHook(() => useGitLabInvestigation("p1"));
		result.current.startInvestigation(issue(7, "opened"), [3]);
		expect(forge.investigateGitLabIssue).toHaveBeenCalledWith("p1", 7, [3]);

		const status = { phase: "analyzing", progress: 20, message: "…" };
		act(() => useGitLabStore.getState().setInvestigationStatus(status as never));
		expect(result.current.investigationStatus).toEqual(status);
		act(() => result.current.resetInvestigationStatus());
		expect(result.current.investigationStatus).toEqual({ phase: "idle", progress: 0, message: "" });
	});

	it("starts nothing without a project", () => {
		const { result } = renderHook(() => useGitLabInvestigation(undefined));
		result.current.startInvestigation(issue(7, "opened"), []);
		expect(forge.investigateGitLabIssue).not.toHaveBeenCalled();
	});
});
