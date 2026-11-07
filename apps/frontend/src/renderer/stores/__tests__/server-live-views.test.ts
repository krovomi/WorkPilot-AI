/** @vitest-environment jsdom */
/**
 * Server mode: a shared view of a server project read again when a teammate
 * changes it. Only the view shown, of the project shown, and never over work
 * the view is following (a generation, an answer being written). The view
 * holds the project's stream while it is shown, and only for a server
 * project.
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
	loadRoadmap: vi.fn(async () => undefined),
	loadIdeation: vi.fn(async () => undefined),
	loadInsightsSession: vi.fn(async () => undefined),
	loadInsightsSessions: vi.fn(async () => undefined),
	loadProjectContext: vi.fn(async () => undefined),
	loadRecentMemories: vi.fn(async () => undefined),
}));

vi.mock("../roadmap-store", async (actual) => ({
	...(await actual<typeof import("../roadmap-store")>()),
	loadRoadmap: loaders.loadRoadmap,
}));
vi.mock("../ideation-store", async (actual) => ({
	...(await actual<typeof import("../ideation-store")>()),
	loadIdeation: loaders.loadIdeation,
}));
vi.mock("../insights-store", async (actual) => ({
	...(await actual<typeof import("../insights-store")>()),
	loadInsightsSession: loaders.loadInsightsSession,
	loadInsightsSessions: loaders.loadInsightsSessions,
}));
vi.mock("../context-store", async (actual) => ({
	...(await actual<typeof import("../context-store")>()),
	loadProjectContext: loaders.loadProjectContext,
	loadRecentMemories: loaders.loadRecentMemories,
}));

import type { Project } from "../../../shared/types";
import { useServerViewLive } from "../../hooks/useServerViewLive";
import { useContextStore } from "../context-store";
import { useIdeationStore } from "../ideation-store";
import { useInsightsStore } from "../insights-store";
import { useProjectStore } from "../project-store";
import { useRoadmapStore } from "../roadmap-store";
import { refreshServerView, setupServerViewListeners } from "../server-live-views";

const api = {
	watchServerView: vi.fn(async () => ({ success: true })),
	unwatchServerView: vi.fn(async () => ({ success: true })),
	onServerViewChanged: vi.fn(),
};

function project(id: string, remote: boolean): Project {
	return {
		id,
		name: id,
		path: `/mirror/${id}`,
		remote: remote ? { repoUrl: "https://x/p.git", defaultBranch: "main", role: "member" } : undefined,
	} as Project;
}

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useProjectStore.setState({
		projects: [project("p-1", true), project("local-1", false)],
		selectedProjectId: "p-1",
		activeProjectId: null,
	});
	useRoadmapStore.setState({
		currentProjectId: "p-1",
		generationStatus: { phase: "idle", progress: 0, message: "" },
	});
	useIdeationStore.setState({ currentProjectId: "p-1", isGenerating: false });
	useInsightsStore.setState({
		session: { id: "s-1" } as never,
		status: { phase: "idle", message: "" },
	});
	useContextStore.setState({ indexLoading: false, memoriesLoading: false });
});

describe("a teammate's change read again", () => {
	it("reads the roadmap or the ideas of the project shown", async () => {
		await refreshServerView({ projectId: "p-1", view: "roadmap" });
		expect(loaders.loadRoadmap).toHaveBeenCalledWith("p-1");
		await refreshServerView({ projectId: "p-1", view: "ideation" });
		expect(loaders.loadIdeation).toHaveBeenCalledWith("p-1");
	});

	it("drops a change of another project", async () => {
		await refreshServerView({ projectId: "p-2", view: "roadmap" });
		await refreshServerView({ projectId: "p-2", view: "insights", sessionId: "s-1" });
		expect(loaders.loadRoadmap).not.toHaveBeenCalled();
		expect(loaders.loadInsightsSession).not.toHaveBeenCalled();
		expect(loaders.loadInsightsSessions).not.toHaveBeenCalled();
	});

	it("leaves a view busy with a generation it follows", async () => {
		useRoadmapStore.setState({
			generationStatus: { phase: "generating", progress: 40, message: "" },
		});
		useIdeationStore.setState({ isGenerating: true });
		await refreshServerView({ projectId: "p-1", view: "roadmap" });
		await refreshServerView({ projectId: "p-1", view: "ideation" });
		expect(loaders.loadRoadmap).not.toHaveBeenCalled();
		expect(loaders.loadIdeation).not.toHaveBeenCalled();
	});

	it("reads the conversation shown when it changed, else only the list", async () => {
		await refreshServerView({ projectId: "p-1", view: "insights", sessionId: "s-1" });
		expect(loaders.loadInsightsSession).toHaveBeenCalledWith("p-1");

		await refreshServerView({ projectId: "p-1", view: "insights", sessionId: "s-9" });
		expect(loaders.loadInsightsSessions).toHaveBeenCalledWith("p-1");
		expect(loaders.loadInsightsSession).toHaveBeenCalledTimes(1);

		// An answer being written is not replaced under the person's eyes.
		useInsightsStore.setState({ status: { phase: "streaming", message: "" } });
		await refreshServerView({ projectId: "p-1", view: "insights", sessionId: "s-1" });
		expect(loaders.loadInsightsSession).toHaveBeenCalledTimes(1);
		expect(loaders.loadInsightsSessions).toHaveBeenCalledTimes(2);
	});

	it("reads the context, or only its memories after a run", async () => {
		await refreshServerView({ projectId: "p-1", view: "context", memoriesOnly: true });
		expect(loaders.loadRecentMemories).toHaveBeenCalledWith("p-1");
		expect(loaders.loadProjectContext).not.toHaveBeenCalled();

		await refreshServerView({ projectId: "p-1", view: "context" });
		expect(loaders.loadProjectContext).toHaveBeenCalledWith("p-1");

		useContextStore.setState({ indexLoading: true });
		await refreshServerView({ projectId: "p-1", view: "context" });
		expect(loaders.loadProjectContext).toHaveBeenCalledTimes(1);
	});

	it("listens once for the window and stops at teardown", () => {
		const off = vi.fn();
		api.onServerViewChanged.mockReturnValue(off);
		const teardown = setupServerViewListeners();
		expect(api.onServerViewChanged).toHaveBeenCalledTimes(1);
		teardown?.();
		expect(off).toHaveBeenCalledTimes(1);
	});
});

describe("a shown view holds the stream", () => {
	it("while a server project's view is shown", () => {
		const { unmount } = renderHook(() => useServerViewLive("p-1", "roadmap"));
		expect(api.watchServerView).toHaveBeenCalledWith("p-1", "roadmap");
		expect(api.unwatchServerView).not.toHaveBeenCalled();
		unmount();
		expect(api.unwatchServerView).toHaveBeenCalledWith("p-1", "roadmap");
	});

	it("and never for a project of this computer", () => {
		const { unmount } = renderHook(() => useServerViewLive("local-1", "insights"));
		unmount();
		expect(api.watchServerView).not.toHaveBeenCalled();
		expect(api.unwatchServerView).not.toHaveBeenCalled();
	});
});
