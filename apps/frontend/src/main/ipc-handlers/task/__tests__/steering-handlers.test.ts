/**
 * @vitest-environment node
 *
 * Steering over IPC: the renderer is not trusted, so a bad task id, an empty
 * or oversized text and a subtask id that is not one never reach the files;
 * a local message is appended to every spec copy, a server card's goes to
 * the server.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dirs: [] as string[],
	card: null as null | { project: { id: string }; cardId: string },
	fetch: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.card }));
vi.mock("../../../server-connection", () => ({ authedFetch: state.fetch }));
vi.mock("../shared", () => ({
	findTaskAndProject: (id: string) =>
		id === "task-1" ? { task: { id }, project: { id: "p" } } : { task: null, project: null },
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: () => ({}),
	allSpecDirs: () => state.dirs,
}));

import { listSteering, sendSteering } from "../steering-handlers";

beforeEach(() => {
	const root = mkdtempSync(path.join(tmpdir(), "steer-"));
	state.dirs = [path.join(root, "a"), path.join(root, "b")];
	for (const dir of state.dirs) mkdirSync(dir, { recursive: true });
	state.card = null;
	state.fetch.mockReset();
});

describe("steering handlers", () => {
	it.each([
		["", "hello", null, "task_not_found"],
		["task-1", "   ", null, "empty_message"],
		["task-1", "x".repeat(9000), null, "message_too_long"],
		["task-1", "ok", "../plan", "invalid_subtask"],
		["task-1", 42, null, "empty_message"],
		["nope", "ok", null, "task_not_found"],
	])("refuses %j / %j / %j", async (taskId, text, target, code) => {
		expect(await sendSteering(taskId, text, target)).toEqual({ success: false, error: code });
	});

	it("appends the message to every copy, which the list reads back once", async () => {
		writeFileSync(
			path.join(state.dirs[1], "steering.jsonl"),
			`${JSON.stringify({ type: "delivered", id: "old", at: "2026-11-06T10:00:00+00:00", session: 2, subtask_id: "s-1" })}\n${JSON.stringify({ type: "message", id: "old", text: "earlier", created_at: "2026-11-06T09:00:00+00:00", source: "cli", target_subtask_id: null })}\n`,
			"utf-8",
		);
		const result = await sendSteering("task-1", "Keep it​ simple", "subtask-2");
		expect(result.success).toBe(true);
		const lines = readFileSync(path.join(state.dirs[0], "steering.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const event = JSON.parse(lines[0]);
		expect(event).toMatchObject({
			type: "message",
			text: "Keep it simple",
			source: "desktop",
			target_subtask_id: "subtask-2",
		});
		const listed = await listSteering("task-1");
		expect(listed.data?.map((m) => [m.text, m.deliveredSession])).toEqual([
			["earlier", 2],
			["Keep it simple", null],
		]);
	});

	it("sends a server card's message to the server, never to a file", async () => {
		state.card = { project: { id: "proj" }, cardId: "001-x" };
		state.fetch.mockResolvedValue({ ok: true, data: { messages: [] } });
		await sendSteering("server:proj:001-x", "hello", null);
		expect(state.fetch).toHaveBeenCalledWith(
			"/api/board/cards/001-x/steering?project_id=proj",
			"POST",
			{ text: "hello", target_subtask_id: null },
		);
	});
});
