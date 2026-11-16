/**
 * Issue investigations are followed for the life of the window, not by the
 * issues page: an investigation that ends while the page is closed still
 * reaches the store, for the project on screen only.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../task-store", () => ({ loadTasks }));

import { setupGitHubInvestigationListeners, useInvestigationStore, useIssuesStore } from "../github";
import { setupGitLabInvestigationListeners, useGitLabStore } from "../gitlab-store";
import { useProjectStore } from "../project-store";

type Handler = (...args: unknown[]) => void;
let handlers: Record<string, Handler>;
let cleanups: Array<ReturnType<typeof vi.fn>>;

function on(name: string) {
	return vi.fn((handler: Handler) => {
		handlers[name] = handler;
		const cleanup = vi.fn();
		cleanups.push(cleanup);
		return cleanup;
	});
}

const GITHUB = useInvestigationStore.getState();
const ISSUES = useIssuesStore.getState();
const GITLAB = useGitLabStore.getState();

beforeEach(() => {
	handlers = {};
	cleanups = [];
	loadTasks.mockReset();
	useInvestigationStore.setState(GITHUB, true);
	useIssuesStore.setState(ISSUES, true);
	useGitLabStore.setState(GITLAB, true);
	useProjectStore.setState({ selectedProjectId: "p1" });
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onGitHubInvestigationProgress: on("ghProgress"),
		onGitHubInvestigationComplete: on("ghComplete"),
		onGitHubInvestigationError: on("ghError"),
		onGitLabInvestigationProgress: on("glProgress"),
		onGitLabInvestigationComplete: on("glComplete"),
		onGitLabInvestigationError: on("glError"),
	};
});

const cases = [
	{
		forge: "GitHub",
		setup: setupGitHubInvestigationListeners,
		prefix: "gh",
		state: () => useInvestigationStore.getState(),
		error: () => useIssuesStore.getState().error,
		errorStatus: { phase: "error", progress: 0, message: "boom", error: "boom" },
	},
	{
		forge: "GitLab",
		setup: setupGitLabInvestigationListeners,
		prefix: "gl",
		state: () => useGitLabStore.getState(),
		error: () => useGitLabStore.getState().error,
		errorStatus: { phase: "error", progress: 0, message: "boom" },
	},
] as const;

describe.each(cases)("$forge investigations", ({ setup, prefix, state, error, errorStatus }) => {
	it("follows the progress and the result of the project on screen", () => {
		setup();
		const status = { phase: "analyzing", progress: 40, message: "…" };
		handlers[`${prefix}Progress`]("p1", status);
		expect(state().investigationStatus).toEqual(status);

		handlers[`${prefix}Complete`]("p1", { success: true, taskId: "t1" });
		expect(state().lastInvestigationResult).toEqual({ success: true, taskId: "t1" });
		expect(loadTasks).toHaveBeenCalledWith("p1");
	});

	it("reloads no task for a result that made none", () => {
		setup();
		handlers[`${prefix}Complete`]("p1", { success: false });
		handlers[`${prefix}Complete`]("p1", { success: true });
		expect(state().lastInvestigationResult).toEqual({ success: true });
		expect(loadTasks).not.toHaveBeenCalled();
	});

	it("shows an investigation error", () => {
		setup();
		handlers[`${prefix}Error`]("p1", "boom");
		expect(error()).toBe("boom");
		expect(state().investigationStatus).toEqual(errorStatus);
	});

	it("ignores the events of another project", () => {
		setup();
		const before = state().investigationStatus;
		handlers[`${prefix}Progress`]("p2", { phase: "analyzing", progress: 1, message: "" });
		handlers[`${prefix}Complete`]("p2", { success: true, taskId: "t" });
		handlers[`${prefix}Error`]("p2", "boom");
		expect(state().investigationStatus).toBe(before);
		expect(state().lastInvestigationResult).toBeNull();
		expect(error()).toBeNull();
		expect(loadTasks).not.toHaveBeenCalled();
	});

	it("drops its three listeners on teardown", () => {
		setup()();
		expect(cleanups).toHaveLength(3);
		for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
	});
});
