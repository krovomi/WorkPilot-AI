/**
 * The ideation handlers on a server project: they read the ideas fresh from
 * the server, send back each change with the version it started from, follow
 * a teammate's job, and make an idea a card of the shared board through the
 * server's own route, never a spec folder on this computer.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	isActiveJob: (job: { status?: string } | null) =>
		!!job && (job.status === "queued" || job.status === "running"),
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

let root: string;
let serverProject: Project;
let localProject: Project;

function ideationFile(project: Project) {
	return path.join(project.path, ".workpilot", "ideation", "ideation.json");
}

function writeIdeas(project: Project, ideas: unknown[]) {
	mkdirSync(path.dirname(ideationFile(project)), { recursive: true });
	writeFileSync(ideationFile(project), JSON.stringify({ id: "s-1", ideas }), "utf-8");
}

function ideasOf(project: Project) {
	return JSON.parse(readFileSync(ideationFile(project), "utf-8")).ideas as Array<{
		id: string;
		status: string;
	}>;
}

const EVENT = {} as never;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "server-ideation-handlers-"));
	serverProject = {
		id: "p-1",
		path: path.join(root, "mirror"),
		remote: { repoUrl: "https://x", defaultBranch: "main", role: "member" },
	} as unknown as Project;
	localProject = { id: "l-1", path: path.join(root, "shop") } as unknown as Project;
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

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("ideas of a server project", () => {
	it("are changed from the server's version, and the change is sent back", async () => {
		const { dismissIdea, deleteMultipleIdeas } = await import("../idea-manager");
		// The server has a teammate's newer list: the change applies to it.
		mocks.pullFeature.mockImplementation(async () => {
			writeIdeas(serverProject, [
				{ id: "a", status: "draft" },
				{ id: "b", status: "draft" },
			]);
			return { success: true, data: { job: null } };
		});
		mocks.pushFeatureFile.mockResolvedValue({ success: true });

		expect(await dismissIdea(EVENT, "p-1", "b")).toEqual({ success: true });
		expect(ideasOf(serverProject).map((i) => i.status)).toEqual(["draft", "dismissed"]);
		expect(mocks.pullFeature).toHaveBeenCalledWith(serverProject, "ideation");
		expect(mocks.pushFeatureFile).toHaveBeenCalledWith(
			serverProject,
			"ideation",
			"ideation.json",
		);

		// Refused by the server: the error reaches the view.
		mocks.pushFeatureFile.mockResolvedValue({
			success: false,
			error: "Changed on the server since it was read",
		});
		expect(await deleteMultipleIdeas(EVENT, "p-1", ["a"])).toEqual({
			success: false,
			error: "Changed on the server since it was read",
		});

		// The server cannot be read: nothing changes.
		mocks.pushFeatureFile.mockClear();
		mocks.pullFeature.mockResolvedValue({ success: false, error: "Server unavailable" });
		expect(await dismissIdea(EVENT, "p-1", "a")).toEqual({
			success: false,
			error: "Server unavailable",
		});
		expect(mocks.pushFeatureFile).not.toHaveBeenCalled();
	});

	it("leave a local project's ideas on this computer", async () => {
		const { archiveIdea } = await import("../idea-manager");
		writeIdeas(localProject, [{ id: "a", status: "draft" }]);
		expect(await archiveIdea(EVENT, "l-1", "a")).toEqual({ success: true });
		expect(ideasOf(localProject)[0].status).toBe("archived");
		expect(mocks.pullFeature).not.toHaveBeenCalled();
		expect(mocks.pushFeatureFile).not.toHaveBeenCalled();
		expect(await archiveIdea(EVENT, "nope", "a")).toEqual({
			success: false,
			error: "Project not found",
		});
	});

	it("are read fresh, and a teammate's running job is followed", async () => {
		const { getIdeationSession } = await import("../session-manager");
		mocks.pullFeature.mockImplementation(async () => {
			writeIdeas(serverProject, [{ id: "a", type: "code_quality", status: "draft" }]);
			return { success: true, data: { job: { id: "job-3", status: "running", error: null } } };
		});
		const follow = vi.fn();
		const result = await getIdeationSession(EVENT, "p-1", follow);
		expect(result.success && result.data?.ideas.map((i) => i.id)).toEqual(["a"]);
		expect(follow).toHaveBeenCalledWith(serverProject, "job-3");

		mocks.pullFeature.mockResolvedValue({
			success: true,
			data: { job: { id: "job-3", status: "succeeded", error: null } },
		});
		follow.mockClear();
		await getIdeationSession(EVENT, "p-1", follow);
		expect(follow).not.toHaveBeenCalled();
	});

	it("become cards of the shared board through the server", async () => {
		const { convertIdeaToTask } = await import("../task-converter");
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { card: { id: "008-split" } } });
		mocks.pullFeature.mockResolvedValue({ success: true, data: { job: null } });
		mocks.serverCardTask.mockResolvedValue({
			success: true,
			data: { id: "server:p-1:008-split" },
		});

		const result = await convertIdeaToTask(EVENT, "p-1", "cq 1");
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/ideation/ideas/cq%201/convert?project_id=p-1",
			"POST",
		);
		expect(mocks.serverCardTask).toHaveBeenCalledWith(serverProject, "008-split");
		expect(result.data?.id).toBe("server:p-1:008-split");
		expect(await convertIdeaToTask(EVENT, "p-1", "")).toEqual({
			success: false,
			error: "Idea not found",
		});
	});
});
