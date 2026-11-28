/**
 * A server project's sprints: the app calls the board's routes with the
 * project's id and the sprint's, and reads the answer back as sprints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authedFetch } = vi.hoisted(() => ({
	authedFetch: vi.fn(async (..._args: unknown[]) => ({ ok: true, data: {} }) as { ok: boolean; data?: unknown; error?: string }),
}));
vi.mock("../../server-connection", () => ({ authedFetch }));

import {
	completeServerSprint,
	deleteServerSprint,
	listServerSprints,
	saveServerSprint,
	startServerSprint,
} from "../server-sprints";

const SPRINT = { id: "sp-0000000a", name: "S", state: "planned", createdAt: "t" };

beforeEach(() => authedFetch.mockClear());

describe("server sprints", () => {
	it("reads the sprints the server answers, leaving out what is not one", async () => {
		authedFetch.mockResolvedValueOnce({ ok: true, data: { sprints: [SPRINT, { id: "bad" }] } });
		expect(await listServerSprints("p 1")).toEqual({ success: true, data: [SPRINT] });
		expect(authedFetch).toHaveBeenCalledWith("/api/board/sprints?project_id=p%201", "GET");
	});

	it("sends each change to its route", async () => {
		const report = { done: 1, donePoints: 2, carried: 0, carriedPoints: 0, carriedTo: null };
		await saveServerSprint("p1", { name: "S" });
		expect(authedFetch).toHaveBeenLastCalledWith("/api/board/sprints?project_id=p1", "POST", { name: "S" });
		await startServerSprint("p1", "sp-0000000a", { cards: 1, points: 2 });
		expect(authedFetch).toHaveBeenLastCalledWith("/api/board/sprints/sp-0000000a/start?project_id=p1", "POST", {
			committed: { cards: 1, points: 2 },
		});
		await completeServerSprint("p1", "sp-0000000a", report);
		expect(authedFetch).toHaveBeenLastCalledWith("/api/board/sprints/sp-0000000a/complete?project_id=p1", "POST", {
			report,
		});
		await deleteServerSprint("p1", "sp-0000000a");
		expect(authedFetch).toHaveBeenLastCalledWith("/api/board/sprints/sp-0000000a?project_id=p1", "DELETE");
	});

	it("passes a refusal on", async () => {
		authedFetch.mockResolvedValueOnce({ ok: false, error: "Another sprint is active" });
		expect(await startServerSprint("p1", "sp-0000000a", { cards: 0, points: 0 })).toEqual({
			success: false,
			error: "Another sprint is active",
		});
	});
});
