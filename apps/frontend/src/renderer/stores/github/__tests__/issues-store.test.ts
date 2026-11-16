/**
 * @vitest-environment jsdom
 */
/**
 * The issue list and the connection status, read from the main process: a
 * failure says why, in the app's words when the main gives none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadGitHubIssues,
	loadMoreGitHubIssues,
	useIssuesStore,
} from "../issues-store";
import { checkGitHubConnection, useSyncStatusStore } from "../sync-status-store";

const api = {
	getGitHubIssues: vi.fn(),
	checkGitHubConnection: vi.fn(),
};

const ISSUE = { id: 1, number: 1, title: "One", state: "open" };

describe("GitHub issue stores", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset();
		Object.assign(globalThis.electronAPI, api);
		useIssuesStore.setState({
			issues: [ISSUE] as never,
			filterState: "open",
			error: null,
			isLoading: false,
			isLoadingMore: false,
			hasMore: true,
			currentPage: 1,
		});
		useSyncStatusStore.setState({ syncStatus: null, connectionError: null });
	});

	const error = () => useIssuesStore.getState().error;

	it.each([
		[{ success: false }, "Could not load the issues"],
		[{ success: false, error: "Rate limited" }, "Rate limited"],
	])("says why the issues cannot be read (%j)", async (answer, message) => {
		api.getGitHubIssues.mockResolvedValue(answer);
		await loadGitHubIssues("p1", "open");
		expect(error()).toBe(message);
		expect(useIssuesStore.getState().isLoading).toBe(false);
	});

	it.each([
		[new Error("IPC down"), "IPC down"],
		["dropped", "Unknown error"],
	])("says why the call failed (%s)", async (thrown, message) => {
		api.getGitHubIssues.mockRejectedValue(thrown);
		await loadGitHubIssues("p1");
		expect(error()).toBe(message);
	});

	it("appends the next page and moves on", async () => {
		api.getGitHubIssues.mockResolvedValue({
			success: true,
			data: { issues: [{ ...ISSUE, id: 2, number: 2 }], hasMore: false },
		});
		await loadMoreGitHubIssues("p1", "open");
		expect(api.getGitHubIssues).toHaveBeenCalledWith("p1", "open", 2, false);
		expect(useIssuesStore.getState()).toMatchObject({ currentPage: 2, hasMore: false, isLoadingMore: false });
		expect(useIssuesStore.getState().issues).toHaveLength(2);
	});

	it.each([
		[{ success: false }, "Could not load more issues"],
		[{ success: false, error: "Page gone" }, "Page gone"],
	])("says why the next page cannot be read (%j)", async (answer, message) => {
		api.getGitHubIssues.mockResolvedValue(answer);
		await loadMoreGitHubIssues("p1", "open");
		expect(error()).toBe(message);
		expect(useIssuesStore.getState().isLoadingMore).toBe(false);
	});

	it.each([
		[new Error("IPC down"), "IPC down"],
		["dropped", "Unknown error"],
	])("says why the next-page call failed (%s)", async (thrown, message) => {
		api.getGitHubIssues.mockRejectedValue(thrown);
		await loadMoreGitHubIssues("p1");
		expect(error()).toBe(message);
	});

	it("drops a next page read for another filter", async () => {
		api.getGitHubIssues.mockImplementation(async () => {
			useIssuesStore.setState({ filterState: "closed" });
			return { success: true, data: { issues: [{ ...ISSUE, id: 9, number: 9 }], hasMore: false } };
		});
		await loadMoreGitHubIssues("p1", "open");
		expect(useIssuesStore.getState().issues).toHaveLength(1);
		expect(useIssuesStore.getState().currentPage).toBe(1);
	});

	it("reads no further page while one is loading or none is left", async () => {
		useIssuesStore.setState({ hasMore: false });
		await loadMoreGitHubIssues("p1");
		useIssuesStore.setState({ hasMore: true, isLoadingMore: true });
		await loadMoreGitHubIssues("p1");
		expect(api.getGitHubIssues).not.toHaveBeenCalled();
	});

	it("forgets the last connection status when a check fails", async () => {
		const sync = () => useSyncStatusStore.getState();
		api.checkGitHubConnection.mockResolvedValue({ success: true, data: { connected: true, repoFullName: "a/b" } });
		await checkGitHubConnection("p1");
		expect(sync().isConnected()).toBe(true);
		expect(sync().getRepoFullName()).toBe("a/b");

		// No reason given: the view says it in the app's language.
		api.checkGitHubConnection.mockResolvedValue({ success: false });
		expect(await checkGitHubConnection("p2")).toBeNull();
		expect(sync()).toMatchObject({ syncStatus: null, connectionError: null });
		expect(sync().isConnected()).toBe(false);
		expect(sync().getRepoFullName()).toBeNull();

		api.checkGitHubConnection.mockResolvedValue({ success: false, error: "No token" });
		await checkGitHubConnection("p2");
		expect(sync().connectionError).toBe("No token");

		api.checkGitHubConnection.mockRejectedValue(new Error("IPC down"));
		await checkGitHubConnection("p2");
		expect(sync().connectionError).toBe("IPC down");

		api.checkGitHubConnection.mockRejectedValue("dropped");
		await checkGitHubConnection("p2");
		expect(sync().connectionError).toBeNull();

		sync().clearSyncStatus();
		expect(sync().syncStatus).toBeNull();
	});
});
