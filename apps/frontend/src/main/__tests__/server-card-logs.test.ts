/**
 * Server mode: a server card's Logs tab reads the build log from the server,
 * never from this computer, and follows it while the tab is open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, TaskLogs } from "../../shared/types";

const connection = vi.hoisted(() => ({ authedFetch: vi.fn() }));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
}));

import {
	SERVER_LOGS_POLL_MS,
	serverCardLogs,
	unwatchAllServerCardLogs,
	unwatchServerCardLogs,
	watchServerCardLogs,
} from "../server-card-logs";

const PROJECT = { id: "p-1", name: "Shop" } as Project;

function logs(text: string): TaskLogs {
	const phase = (name: string) => ({
		phase: name,
		status: "active",
		started_at: null,
		completed_at: null,
		entries: [{ timestamp: "t", type: "text", content: text, phase: name }],
	});
	return {
		spec_id: "001-a",
		created_at: "c",
		updated_at: "u",
		phases: {
			planning: phase("planning"),
			coding: phase("coding"),
			validation: phase("validation"),
		},
	} as unknown as TaskLogs;
}

describe("serverCardLogs", () => {
	beforeEach(() => connection.authedFetch.mockReset());

	it("asks the server for the card's log, by project", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: { logs: logs("hi") } });
		const result = await serverCardLogs(PROJECT, "001-a b");
		expect(connection.authedFetch).toHaveBeenCalledWith(
			"/api/board/cards/001-a%20b/logs?project_id=p-1",
			"GET",
		);
		expect(result.success).toBe(true);
		expect(result.data?.phases.coding.entries[0].content).toBe("hi");
	});

	it("answers null while no run has written a log", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: { logs: null } });
		expect(await serverCardLogs(PROJECT, "001-a")).toEqual({ success: true, data: null });
	});

	it("passes the server's refusal on", async () => {
		connection.authedFetch.mockResolvedValue({ ok: false, error: "Missing permission" });
		expect(await serverCardLogs(PROJECT, "001-a")).toEqual({
			success: false,
			error: "Missing permission",
		});
	});
});

describe("watchServerCardLogs", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		connection.authedFetch.mockReset();
	});
	afterEach(() => {
		unwatchAllServerCardLogs();
		vi.useRealTimers();
	});

	it("sends the logs when they change, and only then", async () => {
		const emit = vi.fn();
		connection.authedFetch.mockResolvedValue({ ok: true, data: { logs: logs("one") } });
		watchServerCardLogs(PROJECT, "001-a", emit);

		await vi.advanceTimersByTimeAsync(SERVER_LOGS_POLL_MS);
		expect(emit).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(SERVER_LOGS_POLL_MS);
		expect(emit).toHaveBeenCalledTimes(1);

		connection.authedFetch.mockResolvedValue({ ok: true, data: { logs: logs("two") } });
		await vi.advanceTimersByTimeAsync(SERVER_LOGS_POLL_MS);
		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit.mock.calls[1][0]).toBe("001-a");
		expect(emit.mock.calls[1][1].phases.coding.entries[0].content).toBe("two");
	});

	it("keeps what is shown when a read fails", async () => {
		const emit = vi.fn();
		connection.authedFetch.mockResolvedValue({ ok: false, error: "offline" });
		watchServerCardLogs(PROJECT, "001-a", emit);
		await vi.advanceTimersByTimeAsync(SERVER_LOGS_POLL_MS * 2);
		expect(emit).not.toHaveBeenCalled();
	});

	it("stops reading once the tab is closed", async () => {
		const emit = vi.fn();
		connection.authedFetch.mockResolvedValue({ ok: true, data: { logs: logs("one") } });
		watchServerCardLogs(PROJECT, "001-a", emit);
		unwatchServerCardLogs("001-a");
		await vi.advanceTimersByTimeAsync(SERVER_LOGS_POLL_MS * 3);
		expect(connection.authedFetch).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});
});
