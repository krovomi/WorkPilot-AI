/**
 * The GitHub issues store: the first page (or every issue for a search),
 * further pages, what a filter change during a page load does, and starting
 * an investigation.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	investigateGitHubIssue,
	loadGitHubIssues,
	loadMoreGitHubIssues,
	useInvestigationStore,
	useIssuesStore,
} from "../github";

const ISSUES = useIssuesStore.getState();
const INVESTIGATION = useInvestigationStore.getState();
const store = () => useIssuesStore.getState();
const issue = (number: number, state: "open" | "closed" = "open") => ({ number, state }) as never;
let api: Record<string, ReturnType<typeof vi.fn>>;

const page = (issues: unknown[], hasMore: boolean) => ({ success: true, data: { issues, hasMore } });

beforeEach(() => {
	useIssuesStore.setState(ISSUES, true);
	useInvestigationStore.setState(INVESTIGATION, true);
	api = {
		getGitHubIssues: vi.fn().mockResolvedValue(page([issue(1), issue(2)], true)),
		investigateGitHubIssue: vi.fn(),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("loadGitHubIssues", () => {
	it("shows the loading state while the first page loads, and drops the selection", async () => {
		let answer: (value: unknown) => void = vi.fn();
		api.getGitHubIssues.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		store().selectIssue(9);
		store().setError("old");
		store().setCurrentPage(4);
		const loading = loadGitHubIssues("p1", "closed");
		expect(store()).toMatchObject({ isLoading: true, error: null, selectedIssueNumber: null, currentPage: 1 });
		expect(api.getGitHubIssues).toHaveBeenCalledWith("p1", "closed", 1, false);

		answer(page([issue(3, "closed")], false));
		await loading;
		expect(store()).toMatchObject({ isLoading: false, issues: [issue(3, "closed")], hasMore: false, currentPage: 1 });
	});

	it("asks for every issue for a search", async () => {
		await loadGitHubIssues("p1", "all", true);
		expect(api.getGitHubIssues).toHaveBeenCalledWith("p1", "all", 1, true);
	});

	it("shows why the issues could not be read", async () => {
		api.getGitHubIssues.mockResolvedValueOnce({ success: false, error: "403" });
		await loadGitHubIssues("p1");
		expect(store()).toMatchObject({ error: "403", isLoading: false });

		api.getGitHubIssues.mockResolvedValueOnce({ success: false });
		await loadGitHubIssues("p1");
		expect(store().error).toBe("Could not load the issues");

		api.getGitHubIssues.mockRejectedValueOnce(new Error("offline"));
		await loadGitHubIssues("p1");
		expect(store().error).toBe("offline");

		api.getGitHubIssues.mockRejectedValueOnce(1);
		await loadGitHubIssues("p1");
		expect(store().error).toBe("Unknown error");
	});
});

describe("loadMoreGitHubIssues", () => {
	beforeEach(async () => {
		await loadGitHubIssues("p1", "open");
	});

	it("appends the next page without repeating an issue", async () => {
		api.getGitHubIssues.mockResolvedValueOnce(page([issue(2), issue(3)], false));
		await loadMoreGitHubIssues("p1", "open");
		expect(api.getGitHubIssues).toHaveBeenLastCalledWith("p1", "open", 2, false);
		expect(store()).toMatchObject({ currentPage: 2, hasMore: false, isLoadingMore: false });
		expect(store().issues.map((i) => i.number)).toEqual([1, 2, 3]);

		api.getGitHubIssues.mockClear();
		await loadMoreGitHubIssues("p1", "open");
		expect(api.getGitHubIssues).not.toHaveBeenCalled();
	});

	it("loads no page while another load runs", async () => {
		api.getGitHubIssues.mockClear();
		store().setLoading(true);
		await loadMoreGitHubIssues("p1");
		store().setLoading(false);
		store().setLoadingMore(true);
		await loadMoreGitHubIssues("p1");
		expect(api.getGitHubIssues).not.toHaveBeenCalled();
	});

	it("drops a page that arrives after the filter changed", async () => {
		let answer: (value: unknown) => void = vi.fn();
		api.getGitHubIssues.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const loading = loadMoreGitHubIssues("p1", "open");
		expect(store().isLoadingMore).toBe(true);
		store().setFilterState("closed");
		answer(page([issue(5)], false));
		await loading;
		expect(store()).toMatchObject({ currentPage: 1, isLoadingMore: false });
		expect(store().issues).toHaveLength(2);
	});

	it("shows why a page could not be read", async () => {
		api.getGitHubIssues.mockResolvedValueOnce({ success: false });
		await loadMoreGitHubIssues("p1");
		expect(store()).toMatchObject({ error: "Could not load more issues", isLoadingMore: false });

		api.getGitHubIssues.mockResolvedValueOnce({ success: false, error: "502" });
		await loadMoreGitHubIssues("p1");
		expect(store().error).toBe("502");

		api.getGitHubIssues.mockRejectedValueOnce(new Error("reset"));
		await loadMoreGitHubIssues("p1");
		expect(store().error).toBe("reset");

		api.getGitHubIssues.mockRejectedValueOnce(null);
		await loadMoreGitHubIssues("p1");
		expect(store().error).toBe("Unknown error");
	});
});

it("filters the issues by state and counts the open ones", () => {
	store().setIssues([issue(1), issue(2, "closed")]);
	expect(store().getFilteredIssues()).toEqual([issue(1)]);
	store().setFilterState("all");
	expect(store().getFilteredIssues()).toHaveLength(2);
	expect(store().getOpenIssuesCount()).toBe(1);
});

it("starts an investigation from a clean result, and clears it", () => {
	const investigation = () => useInvestigationStore.getState();
	investigation().setInvestigationResult({ success: true } as never);
	investigateGitHubIssue("p1", 7, [3]);
	expect(api.investigateGitHubIssue).toHaveBeenCalledWith("p1", 7, [3]);
	expect(investigation()).toMatchObject({
		investigationStatus: { phase: "fetching", issueNumber: 7, progress: 0 },
		lastInvestigationResult: null,
	});
	investigation().clearInvestigation();
	expect(investigation().investigationStatus).toEqual({ phase: "idle", progress: 0, message: "" });
});
