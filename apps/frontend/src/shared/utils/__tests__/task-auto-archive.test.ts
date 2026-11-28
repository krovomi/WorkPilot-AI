/**
 * Auto-archive: which delays the setting takes, when a card was finished,
 * and which cards are old enough to archive.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { autoArchiveDays, autoArchiveIds, finishedAt } from "../task-auto-archive";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 28, 12);
const ago = (days: number) => new Date(now - days * DAY).toISOString();
const card = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, status: "done", metadata: {}, updatedAt: ago(1), ...extra }) as unknown as Task;

describe("autoArchiveDays", () => {
	it("takes one of the offered delays, anything else is off", () => {
		expect(autoArchiveDays(14)).toBe(14);
		expect(autoArchiveDays(0)).toBe(0);
		expect(autoArchiveDays(3)).toBe(0);
		expect(autoArchiveDays("7")).toBe(0);
		expect(autoArchiveDays(undefined)).toBe(0);
	});
});

describe("finishedAt", () => {
	it("is the last move to done, else the last change", () => {
		const moves = [
			{ to: "done", at: ago(20) },
			{ to: "in_progress", at: ago(15) },
			{ to: "done", at: ago(10) },
		];
		expect(finishedAt(card("a", { statusHistory: moves }))).toBe(now - 10 * DAY);
		expect(finishedAt(card("r", { statusHistory: moves.slice(0, 2) }))).toBe(now - 20 * DAY);
		expect(finishedAt(card("b"))).toBe(now - DAY);
		expect(finishedAt(card("c", { updatedAt: "" }))).toBeNull();
		expect(finishedAt(card("d", { updatedAt: "not a date" }))).toBeNull();
		expect(finishedAt(card("e", { updatedAt: null }))).toBeNull();
	});
});

describe("autoArchiveIds", () => {
	it("keeps the local cards done before the delay and not archived yet", () => {
		const tasks = [
			card("old", { updatedAt: ago(20) }),
			card("recent", { updatedAt: ago(3) }),
			card("running", { status: "in_progress", updatedAt: ago(40) }),
			card("archived", { updatedAt: ago(40), metadata: { archivedAt: ago(30) } }),
			card("server:p:1", { updatedAt: ago(40) }),
			card("undated", { updatedAt: "" }),
		];
		expect(autoArchiveIds(tasks, 14, now)).toEqual(["old"]);
		expect(autoArchiveIds(tasks, 0, now)).toEqual([]);
	});
});
