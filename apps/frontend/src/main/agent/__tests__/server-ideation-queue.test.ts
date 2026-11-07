/**
 * Server mode: a server project's ideation runs on the server. The queue
 * starts the job there instead of a runner here, follows it like a child
 * process, and reads each type's ideas from the server as the job announces
 * them, then the whole session when it ends.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdeationConfig, Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	relayServerJob: vi.fn(),
	pullFeature: vi.fn(),
	server: new Map<string, unknown>(),
}));

vi.mock("../../server-features", () => ({
	relayServerJob: mocks.relayServerJob,
	pullFeature: mocks.pullFeature,
}));
vi.mock("../../server-projects", () => ({
	getServerProject: (id: unknown) => mocks.server.get(id as string),
}));
vi.mock("../../claude-profile/credential-utils", () => ({
	clearKeychainCache: vi.fn(),
}));
vi.mock("../../claude-profile/token-refresh", () => ({
	ensureValidToken: vi.fn(),
}));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: vi.fn(),
}));
vi.mock("../../python-env-manager", () => ({
	pythonEnvManager: { getPythonEnv: () => ({}), isEnvReady: () => false },
}));
vi.mock("../../rate-limit-detector", () => ({
	createSDKRateLimitInfo: vi.fn(),
	detectRateLimit: () => ({ isRateLimited: false }),
	getBestAvailableProfileEnv: () => ({ env: {} }),
}));
vi.mock("../../services/profile", () => ({ getAPIProfileEnv: vi.fn() }));
vi.mock("../../services/page-llm-config", () => ({
	getPageProviderEnv: () => ({}),
}));

let mirror: string;

function serverProject(): Project {
	return {
		id: "p-1",
		name: "Shop",
		path: mirror,
		autoBuildPath: ".workpilot",
		settings: {} as Project["settings"],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		remote: { repoUrl: "https://x/shop.git", defaultBranch: "main", role: "member" },
	};
}

function fakeJob() {
	const job = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: () => boolean;
	};
	job.stdout = new EventEmitter();
	job.stderr = new EventEmitter();
	job.kill = vi.fn(() => true);
	return job;
}

function writeMirror(name: string, value: unknown) {
	const directory = path.join(mirror, ".workpilot", "ideation");
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, name), JSON.stringify(value), "utf-8");
}

beforeEach(() => {
	mirror = mkdtempSync(path.join(tmpdir(), "server-ideation-"));
	mocks.relayServerJob.mockReset();
	mocks.pullFeature.mockReset();
	mocks.server = new Map([["p-1", serverProject()]]);
});

afterEach(() => {
	rmSync(mirror, { recursive: true, force: true });
});

describe("a server project's ideation", () => {
	it("runs as a server job, its ideas read from the server as they land", async () => {
		const { AgentQueueManager } = await import("../agent-queue");
		const { AgentState } = await import("../agent-state");
		const { AgentEvents } = await import("../agent-events");
		const emitter = new EventEmitter();
		const processManager = {
			getAutoBuildSourcePath: vi.fn(() => null),
			killProcess: vi.fn(() => false),
		};
		const queue = new AgentQueueManager(
			new AgentState(),
			new AgentEvents(),
			processManager as never,
			emitter,
		);
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		mocks.pullFeature.mockImplementation(async () => {
			writeMirror("code_quality_ideas.json", {
				code_quality: [{ id: "cq-1", type: "code_quality", title: "Split", status: "draft" }],
			});
			return { success: true, data: { job: null } };
		});
		const config: IdeationConfig = {
			enabledTypes: ["code_quality"],
			includeRoadmapContext: true,
			includeKanbanContext: false,
			maxIdeasPerType: 3,
			model: "sonnet",
		};

		await queue.startIdeationGeneration("p-1", mirror, config, true);

		// No source path, no Python: nothing local was needed or started.
		expect(processManager.getAutoBuildSourcePath).not.toHaveBeenCalled();
		expect(mocks.relayServerJob).toHaveBeenCalledWith(serverProject(), "ideation", {
			options: {
				types: ["code_quality"],
				include_roadmap_context: true,
				include_kanban_context: false,
				max_ideas_per_type: 3,
				refresh: true,
				append: false,
				model: "sonnet",
			},
		});
		expect(queue.isIdeationRunning("p-1")).toBe(true);

		const typeDone = new Promise<unknown[]>((resolve) =>
			emitter.on("ideation-type-complete", (_id, _type, ideas) => resolve(ideas)),
		);
		job.stdout.emit("data", Buffer.from("IDEATION_TYPE_COMPLETE:code_quality:1\n"));
		const ideas = (await typeDone) as Array<{ id: string }>;
		expect(mocks.pullFeature).toHaveBeenCalledWith(serverProject(), "ideation");
		expect(ideas.map((idea) => idea.id)).toEqual(["cq-1"]);

		// The relay read the files before exiting 0.
		writeMirror("ideation.json", {
			id: "s-1",
			ideas: [{ id: "cq-1", type: "code_quality", title: "Split", status: "draft" }],
		});
		const complete = new Promise<{ ideas: unknown[] }>((resolve) =>
			emitter.on("ideation-complete", (_id, session) => resolve(session)),
		);
		job.emit("exit", 0);
		expect((await complete).ideas).toHaveLength(1);
		expect(queue.isIdeationRunning("p-1")).toBe(false);
	});

	it("stops the server job when the person stops it", async () => {
		const { AgentQueueManager } = await import("../agent-queue");
		const { AgentState } = await import("../agent-state");
		const { AgentEvents } = await import("../agent-events");
		const state = new AgentState();
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		const queue = new AgentQueueManager(
			state,
			new AgentEvents(),
			{
				killProcess: vi.fn((id: string) => {
					state.getProcess(id)?.process?.kill();
					state.deleteProcess(id);
					return true;
				}),
			} as never,
			new EventEmitter(),
		);
		await queue.followServerIdeation(serverProject(), { jobId: "job-7" });
		expect(mocks.relayServerJob).toHaveBeenCalledWith(serverProject(), "ideation", {
			jobId: "job-7",
		});
		expect(queue.stopIdeation("p-1")).toBe(true);
		expect(job.kill).toHaveBeenCalled();
	});
});
