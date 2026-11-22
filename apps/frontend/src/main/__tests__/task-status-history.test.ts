/**
 * @vitest-environment node
 *
 * Every status a task goes through, in `status_history.json`, on real files:
 * a change appended with who made it, the same status written again ignored,
 * an empty history begun from what the plan said, the file bounded with the
 * creation kept, a damaged file read for what it still holds, and the task
 * the board loads carrying its history (local project and server mirror).
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWindows } from "../platform";
import {
	MAX_ENTRIES,
	parseStatusHistory,
	readStatusHistory,
	recordStatusChange,
	statusHistoryPath,
} from "../task-status-history";

let testDir = "";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === "userData" ? path.join(testDir, "userData") : testDir,
		),
	},
}));

const AT = new Date("2026-11-22T10:00:00Z");

function entries(specDir: string) {
	return JSON.parse(readFileSync(statusHistoryPath(specDir), "utf-8")).entries;
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(tmpdir(), "status-history-"));
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(testDir, { recursive: true, force: true });
});

describe("recordStatusChange", () => {
	it("appends each change with who made it, and ignores the same status", () => {
		expect(
			recordStatusChange(testDir, { to: "backlog", actor: "user", previous: null, at: AT }),
		).toBe(true);
		expect(recordStatusChange(testDir, { to: "in_progress", actor: "agent", at: AT })).toBe(true);
		// The state manager writes a restored status again at every start.
		expect(recordStatusChange(testDir, { to: "in_progress", actor: "agent" })).toBe(false);
		expect(
			recordStatusChange(testDir, { to: "human_review", reason: "completed", actor: "agent" }),
		).toBe(true);
		// Same column, another reason: a move the reports count.
		expect(
			recordStatusChange(testDir, { to: "human_review", reason: "errors", actor: "system" }),
		).toBe(true);

		const written = entries(testDir);
		expect(written[0]).toEqual({
			from: null,
			to: "backlog",
			at: "2026-11-22T10:00:00.000Z",
			actor: "user",
		});
		expect(written.map((e: { from: string | null; to: string; reason?: string; actor: string }) => [e.from, e.to, e.reason, e.actor])).toEqual([
			[null, "backlog", undefined, "user"],
			["backlog", "in_progress", undefined, "agent"],
			["in_progress", "human_review", "completed", "agent"],
			["human_review", "human_review", "errors", "system"],
		]);
		expect(readStatusHistory(testDir)).toEqual(written);
	});

	it("starts an empty history from what the plan said before", () => {
		expect(
			recordStatusChange(testDir, {
				to: "human_review",
				reason: "plan_review",
				actor: "agent",
				previous: { status: "human_review", reason: "plan_review" },
			}),
		).toBe(false);
		expect(
			recordStatusChange(testDir, {
				to: "in_progress",
				actor: "user",
				previous: { status: "human_review", reason: "plan_review" },
			}),
		).toBe(true);
		expect(entries(testDir)[0].from).toBe("human_review");
	});

	it("keeps the creation and the latest changes past the bound", () => {
		const statuses = ["in_progress", "ai_review"] as const;
		recordStatusChange(testDir, { to: "backlog", actor: "user" });
		for (let i = 0; i < MAX_ENTRIES + 5; i++) {
			recordStatusChange(testDir, { to: statuses[i % 2], actor: "agent" });
		}
		const written = entries(testDir);
		expect(written).toHaveLength(MAX_ENTRIES);
		expect(written[0].to).toBe("backlog");
		expect(written.at(-1).to).toBe(statuses[(MAX_ENTRIES + 4) % 2]);
	});

	it("fails nothing when the history cannot be written", () => {
		expect(
			recordStatusChange(path.join(testDir, "no-such-card"), { to: "backlog", actor: "user" }),
		).toBe(false);
	});

	it.skipIf(isWindows())("replaces a link where the file goes instead of following it", () => {
		const outside = path.join(testDir, "outside.json");
		writeFileSync(outside, "keep", "utf-8");
		const card = path.join(testDir, "card");
		mkdirSync(card);
		symlinkSync(outside, statusHistoryPath(card));

		expect(recordStatusChange(card, { to: "backlog", actor: "user" })).toBe(true);
		expect(readFileSync(outside, "utf-8")).toBe("keep");
		expect(lstatSync(statusHistoryPath(card)).isSymbolicLink()).toBe(false);
	});
});

describe("parseStatusHistory", () => {
	const good = { from: null, to: "backlog", at: "2026-11-22T10:00:00Z", actor: "user" };

	it("keeps the valid entries of a damaged file", () => {
		expect(
			parseStatusHistory({
				entries: [
					{ ...good, reason: "nope", accountId: "../etc" },
					{ ...good, from: "backlog", to: "done", reason: "completed", accountId: "u-1" },
					"not an entry",
					{ ...good, to: "shipped" },
					{ ...good, from: "nowhere" },
					{ ...good, actor: "ghost" },
					{ ...good, at: 12 },
					{ ...good, at: "yesterday" },
				],
			}),
		).toEqual([
			good,
			{ ...good, from: "backlog", to: "done", reason: "completed", accountId: "u-1" },
		]);
		expect(parseStatusHistory({ entries: {} })).toEqual([]);
		expect(parseStatusHistory([1, 2])).toEqual([]);
		expect(parseStatusHistory(null)).toEqual([]);
	});

	it("reads no history from a missing or broken file", () => {
		expect(readStatusHistory(testDir)).toEqual([]);
		writeFileSync(statusHistoryPath(testDir), "{", "utf-8");
		expect(readStatusHistory(testDir)).toEqual([]);
	});
});

describe("the task the board loads", () => {
	beforeEach(() => {
		mkdirSync(path.join(testDir, "userData", "store"), { recursive: true });
		vi.resetModules();
	});

	it("carries its history, and none when it has none", async () => {
		const project = path.join(testDir, "project");
		for (const name of ["001-moved", "002-new"]) {
			const specDir = path.join(project, ".workpilot", "specs", name);
			mkdirSync(specDir, { recursive: true });
			writeFileSync(
				path.join(specDir, "implementation_plan.json"),
				JSON.stringify({ feature: name, status: "in_progress", phases: [] }),
				"utf-8",
			);
			writeFileSync(path.join(specDir, "spec.md"), `# ${name}\n`, "utf-8");
		}
		const moved = path.join(project, ".workpilot", "specs", "001-moved");
		recordStatusChange(moved, { to: "backlog", actor: "user", at: AT });
		recordStatusChange(moved, { to: "in_progress", actor: "agent", at: AT });

		const { ProjectStore } = await import("../project-store");
		const store = new ProjectStore();
		const { id } = store.addProject(project);
		const bySpec = Object.fromEntries(
			store.getTasks(id).map((task) => [task.specId, task.statusHistory]),
		);
		expect(bySpec["001-moved"]?.map((e) => e.to)).toEqual(["backlog", "in_progress"]);
		expect(bySpec["002-new"]).toBeUndefined();
	});

	it("is sent by the server's snapshot", async () => {
		const { parseSnapshot } = await import("../remote-board");
		const history = JSON.stringify({ version: 1, entries: [] });
		expect(
			parseSnapshot({ cards: { "001-a": { "status_history.json": history } } })?.cards[
				"001-a"
			],
		).toEqual({ "status_history.json": history });
	});
});
