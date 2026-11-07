/**
 * The roadmap handlers on a server project: they work on the mirror read
 * fresh from the server, and a feature becomes a card of the shared board
 * through the server's own route, never a spec folder on this computer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	pullFeature: vi.fn(),
	pushFeatureFile: vi.fn(),
	serverCardTask: vi.fn(),
	local: new Map<string, unknown>(),
	server: new Map<string, unknown>(),
}));

vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../../server-features", () => ({
	pullFeature: mocks.pullFeature,
	pushFeatureFile: mocks.pushFeatureFile,
}));
vi.mock("../../../server-board-actions", () => ({
	serverCardTask: mocks.serverCardTask,
}));
vi.mock("../../../project-store", () => ({
	projectStore: { getProject: (id: string) => mocks.local.get(id) },
}));
vi.mock("../../../server-projects", () => ({
	getServerProject: (id: unknown) => mocks.server.get(id as string),
}));

const serverProject = {
	id: "p-1",
	path: "/mirror",
	remote: { repoUrl: "https://x", defaultBranch: "main", role: "member" },
} as unknown as Project;
const localProject = { id: "l-1", path: "/work/shop" } as unknown as Project;

beforeEach(() => {
	for (const mock of [
		mocks.authedFetch,
		mocks.pullFeature,
		mocks.pushFeatureFile,
		mocks.serverCardTask,
	]) {
		mock.mockReset();
	}
	mocks.local = new Map([["l-1", localProject]]);
	mocks.server = new Map([["p-1", serverProject]]);
});

describe("server roadmap", () => {
	it("finds a local or a server project, and reads only the server's", async () => {
		const { roadmapProject, refreshServerRoadmap, saveServerRoadmap } =
			await import("../server-roadmap");
		expect(roadmapProject("l-1")).toBe(localProject);
		expect(roadmapProject("p-1")).toBe(serverProject);
		expect(roadmapProject(42)).toBeUndefined();

		expect(await refreshServerRoadmap(localProject)).toBeNull();
		expect(await saveServerRoadmap(localProject)).toEqual({ success: true });
		expect(mocks.pullFeature).not.toHaveBeenCalled();
		expect(mocks.pushFeatureFile).not.toHaveBeenCalled();

		mocks.pullFeature.mockResolvedValue({ success: false, error: "Project not found" });
		expect(await refreshServerRoadmap(serverProject)).toBe("Project not found");
		mocks.pushFeatureFile.mockResolvedValue({ success: true });
		await saveServerRoadmap(serverProject);
		expect(mocks.pushFeatureFile).toHaveBeenCalledWith(
			serverProject,
			"roadmap",
			"roadmap.json",
		);
	});

	it("makes a feature a card of the shared board", async () => {
		const { convertOnServer } = await import("../server-roadmap");
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { card: { id: "007-export" } } });
		mocks.pullFeature.mockResolvedValue({ success: true, data: { job: null } });
		mocks.serverCardTask.mockResolvedValue({ success: true, data: { id: "server:p-1:007-export" } });

		const result = await convertOnServer(serverProject, "f 1");
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/roadmap/features/f%201/convert?project_id=p-1",
			"POST",
		);
		expect(mocks.pullFeature).toHaveBeenCalledWith(serverProject, "roadmap");
		expect(mocks.serverCardTask).toHaveBeenCalledWith(serverProject, "007-export");
		expect(result.data?.id).toBe("server:p-1:007-export");

		mocks.authedFetch.mockResolvedValue({ ok: false, error: "Already converted to a card" });
		expect(await convertOnServer(serverProject, "f1")).toEqual({
			success: false,
			error: "Already converted to a card",
		});
		expect(await convertOnServer(serverProject, "")).toEqual({
			success: false,
			error: "Feature not found",
		});
	});
});
