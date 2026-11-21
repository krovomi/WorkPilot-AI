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

	// A slow answer for the project left behind must not land on the project
	// switched to: its repository, its issues.
	describe("an answer that comes after the project changed", () => {
		const deferred = () => {
			let resolve: (value: unknown) => void = () => undefined;
			const promise = new Promise((r) => {
				resolve = r;
			});
			return { promise, resolve };
		};

		it("does not replace the connection status of the project switched to", async () => {
			const late = deferred();
			api.checkGitHubConnection.mockImplementation((projectId: string) =>
				projectId === "workpilot"
					? late.promise
					: Promise.resolve({
							success: true,
							data: { connected: true, repoFullName: "acme/dotnet" },
						}),
			);
			const first = checkGitHubConnection("workpilot");
			await checkGitHubConnection("dotnet");
			late.resolve({
				success: true,
				data: { connected: true, repoFullName: "krovomi/WorkPilot-AI" },
			});
			expect(await first).toBeNull();
			expect(useSyncStatusStore.getState().getRepoFullName()).toBe("acme/dotnet");
		});

		it("forgets another project's status while the new one is checked", async () => {
			api.checkGitHubConnection.mockResolvedValue({
				success: true,
				data: { connected: true, repoFullName: "krovomi/WorkPilot-AI" },
			});
			await checkGitHubConnection("workpilot");
			api.checkGitHubConnection.mockReturnValue(new Promise(() => undefined));
			void checkGitHubConnection("dotnet");
			expect(useSyncStatusStore.getState().syncStatus).toBeNull();
		});

		it("does not replace the issues of the project switched to", async () => {
			const late = deferred();
			api.getGitHubIssues.mockImplementation((projectId: string) =>
				projectId === "workpilot"
					? late.promise
					: Promise.resolve({
							success: true,
							data: { issues: [{ ...ISSUE, title: "Dotnet" }], hasMore: false },
						}),
			);
			const first = loadGitHubIssues("workpilot", "open");
			await loadGitHubIssues("dotnet", "open");
			late.resolve({ success: true, data: { issues: [ISSUE], hasMore: true } });
			await first;
			expect(useIssuesStore.getState().issues.map((i) => i.title)).toEqual(["Dotnet"]);
			expect(useIssuesStore.getState().isLoading).toBe(false);
		});

		it("does not show the error of a request left behind", async () => {
			let fail: (reason: Error) => void = () => undefined;
			api.getGitHubIssues.mockReturnValueOnce(
				new Promise((_, reject) => {
					fail = reject;
				}),
			);
			const stale = loadGitHubIssues("workpilot", "open");
			api.getGitHubIssues.mockResolvedValue({
				success: true,
				data: { issues: [ISSUE], hasMore: false },
			});
			await loadGitHubIssues("dotnet", "open");
			fail(new Error("late"));
			await stale;
			expect(useIssuesStore.getState().error).toBeNull();
		});

		it("drops a next page asked before the list was read again", async () => {
			const late = deferred();
			api.getGitHubIssues.mockReturnValueOnce(late.promise);
			const more = loadMoreGitHubIssues("workpilot", "open");
			api.getGitHubIssues.mockResolvedValue({
				success: true,
				data: { issues: [{ ...ISSUE, title: "Dotnet" }], hasMore: false },
			});
			await loadGitHubIssues("dotnet", "open");
			late.resolve({ success: true, data: { issues: [{ ...ISSUE, id: 2, number: 2 }], hasMore: true } });
			await more;
			expect(useIssuesStore.getState().issues.map((i) => i.title)).toEqual(["Dotnet"]);
		});
	});
});
