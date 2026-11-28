/**
 * Server mode: the team server's interrupted runs as rows of the launch
 * dialog, and the answer sent back to the server. The server's answer is
 * untrusted: a row that is not one is dropped, every text is bounded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
	serverMode: true,
	token: "access" as string | null,
	calls: [] as Array<{ path: string; method: string; body?: unknown }>,
	answers: new Map<string, { ok: true; data: unknown } | { ok: false; error: string }>(),
}));

vi.mock("../../../server-connection", () => ({
	isServerMode: () => connection.serverMode,
	getAccessToken: () => connection.token,
	authedFetch: async (path: string, method: string, body?: unknown) => {
		connection.calls.push({ path, method, body });
		return connection.answers.get(`${method} ${path}`) ?? { ok: true, data: {} };
	},
}));

vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	collectServerInterruptedTasks,
	isServerInterruptedTask,
	resetServerInterruptedForTests,
	resumeServerInterrupted,
	setServerInterruptedAside,
	toInterruptedTask,
} from "../interrupted-server";

const row = (overrides: Record<string, unknown> = {}) => ({
	run_id: "run-1",
	spec_id: "spec-1",
	card_id: "001-passkey",
	project_id: "proj-1",
	project_name: "Team site",
	title: "Sign in with a passkey",
	run_phase: "build",
	phase: "coding",
	subtasks_done: 1,
	subtasks_total: 3,
	next_subtask: "Ask for the key",
	model: "a-model",
	interrupted_at: "2026-11-28T18:00:00+00:00",
	mine: true,
	started_by_name: null,
	blocker: null,
	...overrides,
});

function listing(runs: unknown[]) {
	connection.answers.set("GET /users/me/interrupted-runs", { ok: true, data: { runs } });
}

beforeEach(() => {
	connection.serverMode = true;
	connection.token = "access";
	connection.calls.length = 0;
	connection.answers.clear();
	resetServerInterruptedForTests();
});

describe("the rows offered", () => {
	it("are the person's runs, as the dialog draws them, ticked", async () => {
		listing([row()]);
		const [task] = await collectServerInterruptedTasks();
		expect(task).toEqual({
			taskId: "server:proj-1:001-passkey",
			projectId: "proj-1",
			projectName: "Team site",
			title: "Sign in with a passkey",
			origin: "server_restart",
			interruptedAt: "2026-11-28T18:00:00.000Z",
			phase: "coding",
			subtasksDone: 1,
			subtasksTotal: 3,
			nextSubtask: "Ask for the key",
			provider: null,
			model: "a-model",
			blocker: null,
			selectedByDefault: true,
			onServer: true,
			startedByName: null,
		});
		expect(isServerInterruptedTask(task.taskId)).toBe(true);
	});

	it("leave a teammate's run, or one that cannot resume, unticked", async () => {
		listing([
			row({ mine: false, started_by_name: "Bob" }),
			row({ run_id: "run-2", card_id: "002-gone", blocker: "spec_missing" }),
		]);
		const [teammate, gone] = await collectServerInterruptedTasks();
		expect(teammate).toMatchObject({ selectedByDefault: false, startedByName: "Bob" });
		expect(gone).toMatchObject({ selectedByDefault: false, blocker: "spec_missing" });
	});

	it("drop what is not a row and bound every text", () => {
		expect(toInterruptedTask(null)).toBeNull();
		expect(toInterruptedTask(row({ run_id: "../x" }))).toBeNull();
		expect(toInterruptedTask(row({ card_id: "not a card" }))).toBeNull();
		expect(toInterruptedTask(row({ project_id: 7 }))).toBeNull();
		const odd = toInterruptedTask(
			row({
				title: `a\u0000b${"x".repeat(400)}`,
				phase: "deploy",
				subtasks_done: -1,
				interrupted_at: "yesterday",
				next_subtask: 5,
			}),
		);
		expect(odd?.title.startsWith("a b")).toBe(true);
		expect(odd?.title.length).toBe(200);
		expect(odd).toMatchObject({
			phase: "coding",
			subtasksDone: 0,
			interruptedAt: null,
			nextSubtask: null,
		});
	});

	it("are none in local mode, signed out, or when the server cannot answer", async () => {
		listing([row()]);
		connection.serverMode = false;
		expect(await collectServerInterruptedTasks()).toEqual([]);
		connection.serverMode = true;
		connection.token = null;
		expect(await collectServerInterruptedTasks()).toEqual([]);
		connection.token = "access";
		connection.answers.set("GET /users/me/interrupted-runs", { ok: false, error: "HTTP 500" });
		expect(await collectServerInterruptedTasks()).toEqual([]);
		connection.answers.set("GET /users/me/interrupted-runs", { ok: true, data: null });
		expect(await collectServerInterruptedTasks()).toEqual([]);
	});
});

describe("the answer", () => {
	it("resumes each run through the server's route, and says which the server refused", async () => {
		listing([row(), row({ run_id: "run-2", spec_id: "spec-2", card_id: "002-other" })]);
		await collectServerInterruptedTasks();
		connection.answers.set("POST /projects/proj-1/specs/spec-2/runs/run-2/resume", {
			ok: false,
			error: "Quota reached",
		});

		const result = await resumeServerInterrupted([
			"server:proj-1:001-passkey",
			"server:proj-1:002-other",
			"server:proj-1:003-unknown",
		]);

		expect(result).toEqual({
			resumed: ["server:proj-1:001-passkey"],
			waiting: [],
			failed: [
				{ taskId: "server:proj-1:002-other", error: "Quota reached" },
				{ taskId: "server:proj-1:003-unknown", error: "Not offered" },
			],
		});
		expect(connection.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
			"/projects/proj-1/specs/spec-1/runs/run-1/resume",
			"/projects/proj-1/specs/spec-2/runs/run-2/resume",
		]);
		expect(isServerInterruptedTask("server:proj-1:001-passkey")).toBe(false);
	});

	it("« Plus tard » tells the server, once, with the run ids", async () => {
		listing([row()]);
		await collectServerInterruptedTasks();
		await setServerInterruptedAside(["server:proj-1:001-passkey", "server:proj-1:009-x"]);
		await setServerInterruptedAside(["server:proj-1:001-passkey"]);
		expect(connection.calls.filter((c) => c.method === "POST")).toEqual([
			{ path: "/users/me/interrupted-runs/later", method: "POST", body: { run_ids: ["run-1"] } },
		]);
	});

	it("a refused « Plus tard » is only logged", async () => {
		listing([row()]);
		await collectServerInterruptedTasks();
		connection.answers.set("POST /users/me/interrupted-runs/later", { ok: false, error: "down" });
		await expect(setServerInterruptedAside(["server:proj-1:001-passkey"])).resolves.toBeUndefined();
	});
});
