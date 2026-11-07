/**
 * Insights on a server project: the person's latest conversation opens, a
 * teammate's is read and never written, a question is asked on the server
 * and its answer followed like the local runner's, then read back as saved.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ID_MAP } from "../../../shared/constants";
import type { InsightsStreamChunk, Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	relayServerJob: vi.fn(),
}));

vi.mock("../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../server-features", () => ({ relayServerJob: mocks.relayServerJob }));

const project = {
	id: "p-1",
	path: "/mirror",
	remote: { repoUrl: "https://x", defaultBranch: "main", role: "member" },
} as unknown as Project;

const T = "2026-10-31T10:00:00+00:00";

function row(id: string, mine: boolean, messages: unknown[] = []) {
	return {
		id,
		projectId: "p-1",
		title: `Talk ${id}`,
		messageCount: messages.length,
		modelConfig: null,
		createdAt: T,
		updatedAt: T,
		ownerId: mine ? "u-1" : "u-2",
		ownerName: mine ? "Ada" : "Bob",
		mine,
		messages,
		jobId: null,
	};
}

function fakeJob() {
	const job = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	job.stdout = new EventEmitter();
	job.stderr = new EventEmitter();
	return job;
}

function events() {
	return {
		chunk: vi.fn(),
		status: vi.fn(),
		error: vi.fn(),
		sessionUpdated: vi.fn(),
	};
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.relayServerJob.mockReset();
	vi.resetModules();
});

describe("server Insights", () => {
	it("opens the person's latest conversation, and shows a teammate's as read only", async () => {
		const { getServerSession, listServerSessions, switchServerSession } =
			await import("../server-insights");
		mocks.authedFetch.mockImplementation(async (url: string) => {
			if (url.startsWith("/api/features/insights/sessions?")) {
				return { ok: true, data: [row("s-2", false), row("s-1", true)] };
			}
			const id = url.split("/sessions/")[1].split("?")[0];
			return { ok: true, data: row(id, id === "s-1") };
		});

		const listed = await listServerSessions(project);
		expect(listed.data?.map((s) => [s.id, s.ownerName, s.readOnly])).toEqual([
			["s-2", "Bob", true],
			["s-1", "Ada", false],
		]);
		const open = await getServerSession(project);
		expect(open.data?.id).toBe("s-1");
		expect(open.data?.readOnly).toBe(false);

		const theirs = await switchServerSession(project, "s-2");
		expect(theirs.data?.readOnly).toBe(true);
		expect(await switchServerSession(project, "../../admin")).toEqual({
			success: false,
			error: "Conversation not found",
		});
	});

	it("asks on the server and follows the answer like the local runner", async () => {
		const { askServer, switchServerSession } = await import("../server-insights");
		const question = { id: "m1", role: "user", content: "Why?", timestamp: T };
		const answer = { id: "m2", role: "assistant", content: "Because.", timestamp: T };
		const calls: Array<[string, string, unknown]> = [];
		mocks.authedFetch.mockImplementation(
			async (url: string, method: string, body?: unknown) => {
				calls.push([url, method, body]);
				if (method === "POST") {
					return {
						ok: true,
						data: { job: { id: "job-1" }, session: row("s-1", true, [question]) },
					};
				}
				return { ok: true, data: row("s-1", true, [question, answer]) };
			},
		);
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		await switchServerSession(project, "s-1");
		const seen = events();

		const asking = askServer(
			project,
			"Why?",
			{ profileId: "balanced", model: "sonnet", thinkingLevel: "high" },
			seen,
		);
		await vi.waitFor(() => expect(mocks.relayServerJob).toHaveBeenCalled());
		expect(calls.find(([, method]) => method === "POST")).toEqual([
			"/api/features/insights/sessions/s-1/messages?project_id=p-1",
			"POST",
			{ message: "Why?", model: MODEL_ID_MAP.sonnet, thinking_level: "high" },
		]);
		expect(mocks.relayServerJob).toHaveBeenCalledWith(project, "insights", {
			jobId: "job-1",
		});
		expect(seen.sessionUpdated.mock.calls[0][0].messages).toHaveLength(1);

		// A line split across reads is one line; markers are not text.
		job.stdout.emit("data", Buffer.from('__TOOL_START__:{"name":"Read","input":"a.ts"}\nBecau'));
		job.stdout.emit("data", Buffer.from("se.\n"));
		job.emit("exit", 0);
		await asking;

		const chunks = seen.chunk.mock.calls.map(([c]) => c as InsightsStreamChunk);
		expect(chunks).toEqual([
			{ type: "tool_start", tool: { name: "Read", input: "a.ts" } },
			{ type: "text", content: "Because.\n" },
			{ type: "done" },
		]);
		expect(seen.status).toHaveBeenLastCalledWith({ phase: "complete" });
		expect(seen.sessionUpdated.mock.calls.at(-1)?.[0].messages).toHaveLength(2);
	});

	it("never asks in a teammate's conversation", async () => {
		const { askServer, switchServerSession } = await import("../server-insights");
		mocks.authedFetch.mockResolvedValue({ ok: true, data: row("s-2", false) });
		await switchServerSession(project, "s-2");
		const seen = events();
		await askServer(project, "Mine?", undefined, seen);
		expect(seen.error).toHaveBeenCalledWith(
			"This conversation is a teammate's: start your own to ask",
		);
		expect(mocks.authedFetch).not.toHaveBeenCalledWith(
			expect.stringContaining("/messages"),
			"POST",
			expect.anything(),
		);
	});

	it("reports a server refusal and a failed answer", async () => {
		const { askServer, switchServerSession } = await import("../server-insights");
		mocks.authedFetch.mockImplementation(async (_url: string, method: string) =>
			method === "POST"
				? { ok: false, error: "An answer is being written" }
				: { ok: true, data: row("s-1", true) },
		);
		await switchServerSession(project, "s-1");
		const refused = events();
		await askServer(project, "Again", undefined, refused);
		expect(refused.error).toHaveBeenCalledWith("An answer is being written");

		mocks.authedFetch.mockImplementation(async (_url: string, method: string) =>
			method === "POST"
				? { ok: true, data: { job: { id: "job-2" }, session: row("s-1", true) } }
				: { ok: true, data: row("s-1", true) },
		);
		const job = fakeJob();
		mocks.relayServerJob.mockReturnValue(job);
		const failed = events();
		const asking = askServer(project, "Now", undefined, failed);
		await vi.waitFor(() => expect(mocks.relayServerJob).toHaveBeenCalled());
		job.stderr.emit("data", Buffer.from("Rate limited\n"));
		job.emit("exit", 1);
		await asking;
		expect(failed.error).toHaveBeenCalledWith("Rate limited");
	});
});
