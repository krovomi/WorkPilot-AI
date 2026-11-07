/**
 * The Context view of a server project: its memories are read from the
 * server, checked to the tab's shape, and never located; its index is
 * rebuilt by a server job and read back from the mirror.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	relayServerJob: vi.fn(),
	refreshServerFeature: vi.fn(),
}));

vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../../server-features", () => ({
	relayServerJob: mocks.relayServerJob,
}));
vi.mock("../../server-feature-files", () => ({
	refreshServerFeature: mocks.refreshServerFeature,
}));

let mirror: string;
let project: Project;

function fakeJob() {
	const job = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	job.stdout = new EventEmitter();
	job.stderr = new EventEmitter();
	return job;
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.relayServerJob.mockReset();
	mocks.refreshServerFeature.mockReset();
	mirror = mkdtempSync(path.join(tmpdir(), "server-context-"));
	project = {
		id: "p-1",
		path: mirror,
		remote: { repoUrl: "https://x", defaultBranch: "main", role: "member" },
	} as unknown as Project;
});

afterEach(() => {
	rmSync(mirror, { recursive: true, force: true });
});

describe("server project context", () => {
	it("reads the project's memories from the server, by project id", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: {
				available: true,
				memories: [
					{
						id: "knowledge/projects/p/memory/gotchas/a.md",
						type: "gotcha",
						timestamp: "2026-10-31T10:00:00+00:00",
						content: "x".repeat(5_000),
						path: "knowledge/projects/p/memory/gotchas/a.md",
					},
					{ id: "", content: "no id" },
					"not a row",
				],
			},
		});
		const { fetchServerMemories } = await import("../server-context");
		const read = await fetchServerMemories(project, { limit: 9_999 });

		const [url, method] = mocks.authedFetch.mock.calls[0];
		expect(method).toBe("GET");
		expect(url).toBe("/api/features/context/memories?project_id=p-1&limit=200");
		expect(read.success).toBe(true);
		expect(read.data?.status).toEqual({
			enabled: true,
			available: true,
			database: "WorkPilot Brain",
			onServer: true,
		});
		expect(read.data?.status.dbPath).toBeUndefined();
		expect(read.data?.memories).toHaveLength(1);
		expect(read.data?.memories[0].content).toHaveLength(2_000);
	});

	it("searches with the query, and says when the project has no memory yet", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: { available: false, results: [] },
		});
		const { fetchServerMemories } = await import("../server-context");
		const read = await fetchServerMemories(project, { query: "  lockfile  " });

		expect(mocks.authedFetch.mock.calls[0][0]).toBe(
			"/api/features/context/memories?project_id=p-1&limit=20&query=lockfile",
		);
		expect(read.data?.status.available).toBe(false);
		expect(read.data?.status.reason).toBe("reasons.serverBrainNotCreated");
	});

	it("passes a server refusal on", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: false, error: "Forbidden" });
		const { fetchServerMemories } = await import("../server-context");
		expect(await fetchServerMemories(project, {})).toEqual({
			success: false,
			error: "Forbidden",
		});
	});

	it("rebuilds the index with a server job and reads it from the mirror", async () => {
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		const { rebuildServerIndex } = await import("../server-context");
		const rebuilt = rebuildServerIndex(project);
		expect(mocks.relayServerJob).toHaveBeenCalledWith(project, "context", {
			options: {},
		});
		mkdirSync(path.join(mirror, ".workpilot"));
		writeFileSync(
			path.join(mirror, ".workpilot", "project_index.json"),
			JSON.stringify({ project_type: "single", services: {} }),
		);
		job.emit("exit", 0);
		expect(await rebuilt).toEqual({
			success: true,
			data: { project_type: "single", services: {} },
		});
	});

	it("reports why the server could not rebuild it", async () => {
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		const { rebuildServerIndex } = await import("../server-context");
		const rebuilt = rebuildServerIndex(project);
		job.stderr.emit("data", Buffer.from("A job is already running for this feature\n"));
		job.emit("exit", 1);
		expect(await rebuilt).toEqual({
			success: false,
			error: "A job is already running for this feature",
		});
	});
});
