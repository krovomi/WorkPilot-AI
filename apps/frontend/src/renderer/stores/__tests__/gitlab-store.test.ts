/**
 * The GitLab issues store: loading the issues of a filter, checking the
 * connection, starting an investigation, and the counts the page shows. An
 * answer that arrives after the person left its project is dropped.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { checkGitLabConnection, investigateGitLabIssue, loadGitLabIssues, useGitLabStore } from "../gitlab-store";
import { useProjectStore } from "../project-store";

const INITIAL = useGitLabStore.getState();
const store = () => useGitLabStore.getState();
let api: Record<string, ReturnType<typeof vi.fn>>;
const issue = (iid: number, state: "opened" | "closed") => ({ iid, state }) as never;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((ok, ko) => {
		resolve = ok;
		reject = ko;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useGitLabStore.setState(INITIAL, true);
	useProjectStore.setState({ selectedProjectId: "p1" });
	api = {
		getGitLabIssues: vi.fn().mockResolvedValue({ success: true, data: [issue(1, "opened")] }),
		checkGitLabConnection: vi.fn().mockResolvedValue({ success: true, data: { connected: true } }),
		investigateGitLabIssue: vi.fn(),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("loadGitLabIssues", () => {
	it("shows the loading state while the issues of the filter load", async () => {
		let answer: (value: unknown) => void = vi.fn();
		api.getGitLabIssues.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		store().setError("old");
		const loading = loadGitLabIssues("p1", "closed");
		expect(store()).toMatchObject({ isLoading: true, error: null, filterState: "closed" });
		expect(api.getGitLabIssues).toHaveBeenCalledWith("p1", "closed");

		answer({ success: true, data: [issue(2, "closed")] });
		await loading;
		expect(store()).toMatchObject({ isLoading: false, issues: [issue(2, "closed")] });
	});

	it("keeps the filter when none is given, and shows why loading failed", async () => {
		store().setFilterState("all");
		api.getGitLabIssues.mockResolvedValueOnce({ success: false, error: "401" });
		await loadGitLabIssues("p1");
		expect(store()).toMatchObject({ filterState: "all", error: "401", isLoading: false });

		api.getGitLabIssues.mockResolvedValueOnce({ success: false });
		await loadGitLabIssues("p1");
		expect(store().error).toBe("Failed to load GitLab issues");

		api.getGitLabIssues.mockRejectedValueOnce(new Error("ENOTFOUND"));
		await loadGitLabIssues("p1");
		expect(store().error).toBe("ENOTFOUND");

		api.getGitLabIssues.mockRejectedValueOnce("x");
		await loadGitLabIssues("p1");
		expect(store()).toMatchObject({ error: "Unknown error", isLoading: false });
	});
});

describe("checkGitLabConnection", () => {
	it("keeps the connection status, or says why it could not be read", async () => {
		expect(await checkGitLabConnection("p1")).toEqual({ connected: true });
		expect(store().syncStatus).toEqual({ connected: true });

		api.checkGitLabConnection.mockResolvedValueOnce({ success: false, error: "No token" });
		expect(await checkGitLabConnection("p1")).toBeNull();
		expect(store().error).toBe("No token");

		api.checkGitLabConnection.mockResolvedValueOnce({ success: true });
		await checkGitLabConnection("p1");
		expect(store().error).toBe("Failed to check GitLab connection");

		api.checkGitLabConnection.mockRejectedValueOnce(new Error("offline"));
		expect(await checkGitLabConnection("p1")).toBeNull();
		expect(store().error).toBe("offline");

		api.checkGitLabConnection.mockRejectedValueOnce(42);
		await checkGitLabConnection("p1");
		expect(store().error).toBe("Unknown error");
	});
});

describe("an answer for a project the person left", () => {
	it("keeps the connection of the project shown when an older check answers last", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.checkGitLabConnection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const leaving = checkGitLabConnection("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		const shown = checkGitLabConnection("p2");

		second.resolve({ success: true, data: { connected: true, projectPathWithNamespace: "team/p2" } });
		expect(await shown).toEqual({ connected: true, projectPathWithNamespace: "team/p2" });
		first.resolve({ success: true, data: { connected: false } });
		expect(await leaving).toBeNull();

		expect(store().syncStatus).toEqual({ connected: true, projectPathWithNamespace: "team/p2" });
		expect(api.checkGitLabConnection.mock.calls).toEqual([["p1"], ["p2"]]);
	});

	it("does not show the failure of a check for a project left meanwhile", async () => {
		const refused = deferred<unknown>();
		const thrown = deferred<unknown>();
		api.checkGitLabConnection.mockReturnValueOnce(refused.promise).mockReturnValueOnce(thrown.promise);
		const a = checkGitLabConnection("p1");
		const b = checkGitLabConnection("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		refused.resolve({ success: false, error: "No token" });
		thrown.reject(new Error("offline"));
		expect(await a).toBeNull();
		expect(await b).toBeNull();
		expect(store()).toMatchObject({ error: null, syncStatus: null });
	});

	it("keeps the issues and the loading state of the project shown", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		api.getGitLabIssues.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const leaving = loadGitLabIssues("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		const shown = loadGitLabIssues("p2");

		// The old answer, then its failure, change nothing while p2 loads
		first.resolve({ success: true, data: [issue(1, "opened")] });
		await leaving;
		expect(store()).toMatchObject({ issues: [], isLoading: true });

		second.resolve({ success: true, data: [issue(9, "closed")] });
		await shown;
		expect(store()).toMatchObject({ issues: [issue(9, "closed")], isLoading: false });
	});

	it("does not show the failure of a load for a project left meanwhile", async () => {
		const refused = deferred<unknown>();
		const thrown = deferred<unknown>();
		api.getGitLabIssues.mockReturnValueOnce(refused.promise).mockReturnValueOnce(thrown.promise);
		const a = loadGitLabIssues("p1");
		const b = loadGitLabIssues("p1");
		useProjectStore.setState({ selectedProjectId: "p2" });
		refused.resolve({ success: false, error: "401" });
		thrown.reject(new Error("ENOTFOUND"));
		await a;
		await b;
		expect(store()).toMatchObject({ error: null, isLoading: true });
	});
});

it("starts an investigation from a clean result", () => {
	store().setInvestigationResult({ success: true } as never);
	investigateGitLabIssue("p1", 7, [3]);
	expect(api.investigateGitLabIssue).toHaveBeenCalledWith("p1", 7, [3]);
	expect(store()).toMatchObject({
		investigationStatus: {
			phase: "fetching",
			issueIid: 7,
			progress: 0,
			message: "Reading the issue...",
		},
		lastInvestigationResult: null,
	});
});

it("filters the issues by state and counts the open ones", () => {
	store().setIssues([issue(1, "opened"), issue(2, "closed"), issue(3, "opened")]);
	expect(store().getFilteredIssues().map((i) => i.iid)).toEqual([1, 3]);
	store().setFilterState("closed");
	expect(store().getFilteredIssues().map((i) => i.iid)).toEqual([2]);
	store().setFilterState("all");
	expect(store().getFilteredIssues()).toHaveLength(3);
	expect(store().getOpenIssuesCount()).toBe(2);
});
