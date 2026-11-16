/**
 * The GitHub issues page hooks: when issues load (once per change of filter,
 * connection or search mode, never twice), paging, the selected issue, the
 * search box, and the investigation shown on the page.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forge = vi.hoisted(() => ({
	checkGitHubConnection: vi.fn(),
	loadGitHubIssues: vi.fn(),
	loadMoreGitHubIssues: vi.fn(),
	investigateGitHubIssue: vi.fn(),
}));
vi.mock("../../../../stores/github", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...forge,
}));

import { useInvestigationStore, useIssuesStore, useSyncStatusStore } from "../../../../stores/github";
import { useGitHubInvestigation } from "../useGitHubInvestigation";
import { useGitHubIssues } from "../useGitHubIssues";
import { useIssueFiltering } from "../useIssueFiltering";

const issue = (number: number, state: "open" | "closed", title = `Issue ${number}`, body?: string) =>
	({ number, state, title, body }) as never;
const ISSUES = useIssuesStore.getState();
const SYNC = useSyncStatusStore.getState();
const INVESTIGATION = useInvestigationStore.getState();

beforeEach(() => {
	for (const fn of Object.values(forge)) fn.mockReset();
	useIssuesStore.setState(ISSUES, true);
	useSyncStatusStore.setState(SYNC, true);
	useInvestigationStore.setState(INVESTIGATION, true);
});

const connect = () => act(() => useSyncStatusStore.setState({ syncStatus: { connected: true } as never }));

describe("useGitHubIssues", () => {
	it("checks the connection, then loads the first page once connected", () => {
		const { rerender } = renderHook(({ id }) => useGitHubIssues(id), { initialProps: { id: "p1" as string | undefined } });
		expect(forge.checkGitHubConnection).toHaveBeenCalledWith("p1");
		expect(forge.loadGitHubIssues).not.toHaveBeenCalled();
		connect();
		expect(forge.loadGitHubIssues).toHaveBeenCalledOnce();
		expect(forge.loadGitHubIssues).toHaveBeenCalledWith("p1", "open", false);

		rerender({ id: undefined });
		expect(forge.checkGitHubConnection).toHaveBeenCalledOnce();
	});

	it("loads once per filter change", () => {
		useSyncStatusStore.setState({ syncStatus: { connected: true } as never });
		const { result } = renderHook(() => useGitHubIssues("p1"));
		forge.loadGitHubIssues.mockClear();
		act(() => result.current.handleFilterChange("closed" as never));
		expect(forge.loadGitHubIssues.mock.calls).toEqual([["p1", "closed", false]]);
	});

	it("loads every issue once for a search, and the first page once when it is cleared", () => {
		useSyncStatusStore.setState({ syncStatus: { connected: true } as never });
		useIssuesStore.setState({ hasMore: true });
		const { result } = renderHook(() => useGitHubIssues("p1"));
		forge.loadGitHubIssues.mockClear();

		act(() => result.current.handleSearchStart());
		act(() => result.current.handleSearchStart());
		expect(forge.loadGitHubIssues.mock.calls).toEqual([["p1", "open", true]]);
		expect(result.current.hasMore).toBe(false);
		act(() => result.current.handleLoadMore());
		expect(forge.loadMoreGitHubIssues).not.toHaveBeenCalled();

		act(() => result.current.handleSearchClear());
		act(() => result.current.handleSearchClear());
		expect(forge.loadGitHubIssues.mock.calls).toEqual([
			["p1", "open", true],
			["p1", "open", false],
		]);
		expect(result.current.hasMore).toBe(true);
		act(() => result.current.handleLoadMore());
		expect(forge.loadMoreGitHubIssues).toHaveBeenCalledWith("p1", "open");
	});

	it("leaves search mode when the project changes", () => {
		useSyncStatusStore.setState({ syncStatus: { connected: true } as never });
		const { result, rerender } = renderHook(({ id }) => useGitHubIssues(id), { initialProps: { id: "p1" } });
		act(() => result.current.handleSearchStart());
		forge.loadGitHubIssues.mockClear();
		rerender({ id: "p2" });
		expect(forge.checkGitHubConnection).toHaveBeenLastCalledWith("p2");
		expect(forge.loadGitHubIssues).toHaveBeenLastCalledWith("p2", "open", false);
	});

	it("refreshes the connection and the issues in the current mode", () => {
		const { result } = renderHook(() => useGitHubIssues("p1"));
		act(() => result.current.handleSearchStart());
		forge.checkGitHubConnection.mockClear();
		act(() => result.current.handleRefresh());
		expect(forge.checkGitHubConnection).toHaveBeenCalledWith("p1");
		expect(forge.loadGitHubIssues).toHaveBeenCalledWith("p1", "open", true);
	});

	it("does nothing without a project", () => {
		const { result } = renderHook(() => useGitHubIssues(undefined));
		act(() => {
			result.current.handleRefresh();
			result.current.handleLoadMore();
		});
		expect(forge.checkGitHubConnection).not.toHaveBeenCalled();
		expect(forge.loadMoreGitHubIssues).not.toHaveBeenCalled();
	});

	it("reads the issues, the selection and the counts from the store", () => {
		useIssuesStore.setState({ issues: [issue(1, "open"), issue(2, "closed")] });
		const { result } = renderHook(() => useGitHubIssues("p1"));
		expect(result.current.selectedIssue).toBeNull();
		act(() => result.current.selectIssue(2));
		expect(result.current).toMatchObject({ selectedIssueNumber: 2, selectedIssue: issue(2, "closed") });
		expect(result.current.getOpenIssuesCount()).toBe(1);
	});
});

describe("useIssueFiltering", () => {
	it("filters by title or body and says when a search starts and ends", () => {
		const onSearchStart = vi.fn();
		const onSearchClear = vi.fn();
		const issues = [issue(1, "open", "Login crash", "token"), issue(2, "open", "Docs", undefined)];
		const { result } = renderHook(() => useIssueFiltering(issues, { onSearchStart, onSearchClear }));
		expect(onSearchClear).toHaveBeenCalledOnce();
		expect(result.current.filteredIssues).toHaveLength(2);

		act(() => result.current.setSearchQuery("TOKEN"));
		expect(result.current).toMatchObject({ isSearchActive: true, filteredIssues: [issues[0]] });
		expect(onSearchStart).toHaveBeenCalledOnce();

		act(() => result.current.setSearchQuery("crash"));
		expect(result.current.filteredIssues).toEqual([issues[0]]);
		act(() => result.current.setSearchQuery(""));
		expect(result.current.isSearchActive).toBe(false);
		expect(onSearchClear).toHaveBeenCalledTimes(2);
	});

	it("works without callbacks", () => {
		const { result } = renderHook(() => useIssueFiltering([]));
		act(() => result.current.setSearchQuery("x"));
		expect(result.current.filteredIssues).toEqual([]);
	});
});

describe("useGitHubInvestigation", () => {
	it("starts an investigation of the issue with the chosen comments, and resets the status", () => {
		const { result } = renderHook(() => useGitHubInvestigation("p1"));
		result.current.startInvestigation(issue(7, "open"), [3]);
		expect(forge.investigateGitHubIssue).toHaveBeenCalledWith("p1", 7, [3]);

		const status = { phase: "analyzing", progress: 20, message: "…" };
		act(() => useInvestigationStore.getState().setInvestigationStatus(status as never));
		expect(result.current.investigationStatus).toEqual(status);
		act(() => result.current.resetInvestigationStatus());
		expect(result.current.investigationStatus).toEqual({ phase: "idle", progress: 0, message: "" });
	});

	it("starts nothing without a project", () => {
		const { result } = renderHook(() => useGitHubInvestigation(undefined));
		result.current.startInvestigation(issue(7, "open"), []);
		expect(forge.investigateGitHubIssue).not.toHaveBeenCalled();
	});
});
