import { describe, expect, it } from "vitest";
import type { Task } from "../types/task";
import {
	blockedReasons,
	buildFlagMetadata,
	buildUnflagMetadata,
	isTaskFlagged,
	MAX_FLAG_REASON,
} from "./task-flag";

const task = (metadata: Task["metadata"]) => ({ metadata }) as Pick<Task, "metadata">;

describe("task flag", () => {
	it("flags with the date and a trimmed, bounded reason", () => {
		const now = new Date("2026-11-22T10:00:00.000Z");
		expect(buildFlagMetadata("  waiting for the client  ", now)).toEqual({
			flagged: true,
			flaggedAt: "2026-11-22T10:00:00.000Z",
			flaggedReason: "waiting for the client",
		});
		expect(buildFlagMetadata("x".repeat(MAX_FLAG_REASON + 10), now).flaggedReason).toHaveLength(
			MAX_FLAG_REASON,
		);
		expect(buildFlagMetadata().flaggedReason).toBeUndefined();
	});

	it("lifts the flag and clears why", () => {
		expect(buildUnflagMetadata()).toEqual({
			flagged: false,
			flaggedReason: undefined,
			flaggedAt: undefined,
		});
	});

	it("reads the flag strictly", () => {
		expect(isTaskFlagged(task({ flagged: true }))).toBe(true);
		expect(isTaskFlagged(task({ flagged: false }))).toBe(false);
		expect(isTaskFlagged(task(undefined))).toBe(false);
	});

	it("says why a task cannot move on", () => {
		expect(blockedReasons(task(undefined))).toEqual([]);
		expect(
			blockedReasons(
				task({ flagged: true, paused: { enabled: true, paused_at: null } } as Task["metadata"]),
				2,
			),
		).toEqual(["flagged", "paused", "blockers"]);
	});
});
