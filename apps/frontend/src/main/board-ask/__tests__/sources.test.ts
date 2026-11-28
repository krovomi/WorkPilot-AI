/**
 * The other sources of « Interroger le tableau »: the roadmap and the ideas
 * are read from the project's own `.workpilot/` files, inside the project and
 * bounded; the merged changes from `git log`, without a shell. A feature or
 * an idea already on the board is not read twice, and a source that cannot be
 * read is simply left out.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown> | undefined,
	settingsThrow: false,
	execFile: vi.fn(),
	toolThrows: false,
}));

vi.mock("../../cli-tool-manager", () => ({
	getToolPath: () => {
		if (state.toolThrows) throw new Error("no git");
		return "/usr/bin/git";
	},
}));
vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => {
		if (state.settingsThrow) throw new Error("unreadable");
		return state.settings;
	},
}));
vi.mock("node:child_process", () => ({ execFile: state.execFile }));

import {
	boardSources,
	changeTicket,
	MAX_SOURCE_BYTES,
	readBoardSources,
	readBoardSourcesSetting,
	readChangeTickets,
	readIdeaTickets,
	readProjectJson,
	readRoadmapTickets,
} from "../sources";

const F = "\x1f";
const R = "\x1e";
let dir: string;

function write(rel: string, data: unknown) {
	const file = path.join(dir, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), "utf-8");
}

const card = (id: string, specId = id) => ({ id, specId, title: id }) as Task;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "board-sources-"));
	state.settings = {};
	state.settingsThrow = false;
	state.toolThrows = false;
	state.execFile.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readProjectJson", () => {
	it("reads an object inside the project", () => {
		write("a/b.json", { ok: true });
		expect(readProjectJson(dir, "a", "b.json")).toEqual({ ok: true });
	});

	it("reads nothing missing, unparsable, not an object, too large, or leading out of the project", () => {
		expect(readProjectJson(dir, "missing.json")).toBeNull();
		write("bad.json", "{nope");
		expect(readProjectJson(dir, "bad.json")).toBeNull();
		write("list.json", [1]);
		expect(readProjectJson(dir, "list.json")).toBeNull();
		write("null.json", "null");
		expect(readProjectJson(dir, "null.json")).toBeNull();
		write("big.json", `{"x":"${"a".repeat(MAX_SOURCE_BYTES)}"}`);
		expect(readProjectJson(dir, "big.json")).toBeNull();
		const outside = mkdtempSync(path.join(tmpdir(), "board-outside-"));
		try {
			writeFileSync(path.join(outside, "x.json"), "{}", "utf-8");
			// A junction: a link Windows lets anyone create.
			symlinkSync(outside, path.join(dir, "link"), "junction");
			expect(readProjectJson(dir, "link", "x.json")).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("readRoadmapTickets", () => {
	it("reads the features not yet on the board, with their state and criteria", () => {
		write(".workpilot/roadmap/roadmap.json", {
			features: [
				{
					id: "f1",
					title: "Export CSV",
					description: "Users to CSV",
					rationale: "Admins ask for it",
					status: "in_progress",
					acceptance_criteria: ["Filter by role", 4, ""],
					userStories: ["As an admin I export"],
				},
				{ id: "f2", title: "Dark mode", status: "done" },
				{ id: "f3", title: "SSO", status: "completed" },
				{ id: "f4", title: "Audit log", status: "under_review" },
				{ id: "f5", title: "On the board", linked_spec_id: "spec-5" },
				{ id: "f6", title: "Linked elsewhere", linkedSpecId: "gone" },
				{ id: "", title: "No id" },
				{ id: "f7", title: "" },
				"not a feature",
				null,
			],
		});
		const tickets = readRoadmapTickets(dir, [card("t5", "spec-5"), { id: "t6", title: "x" } as Task]);
		expect(tickets.map((t) => [t.id, t.state])).toEqual([
			["roadmap:f1", "in_progress"],
			["roadmap:f2", "done"],
			["roadmap:f3", "done"],
			["roadmap:f4", "planned"],
			["roadmap:f6", "planned"],
		]);
		expect(tickets[0]).toEqual({
			id: "roadmap:f1",
			title: "Export CSV",
			description: "Users to CSV",
			spec: "Admins ask for it",
			subtasks: ["Filter by role", "As an admin I export"],
			files: [],
			state: "in_progress",
			archived: false,
			kind: "roadmap",
		});
	});

	it("reads nothing without a roadmap, or with no feature list", () => {
		expect(readRoadmapTickets(dir, [])).toEqual([]);
		write(".workpilot/roadmap/roadmap.json", { features: "none" });
		expect(readRoadmapTickets(dir, [])).toEqual([]);
	});
});

describe("readIdeaTickets", () => {
	it("reads the ideas not yet turned into a task, dismissed and archived ones as abandoned", () => {
		write(".workpilot/ideation/ideation.json", {
			ideas: [
				{
					id: "i1",
					title: "Faster search",
					description: "Index the logs",
					rationale: "Search is slow",
					proposed_change: "Add an index",
					affected_files: ["src/search.ts"],
					status: "draft",
					created_at: "2026-11-02T10:00:00Z",
				},
				{ id: "i2", title: "Old idea", status: "dismissed", implementation: "Cache it", createdAt: "not a date" },
				{ id: "i3", title: "Shelved", status: "archived", proposedChange: "Later" },
				{ id: "i4", title: "Already a task", linked_task_id: "t1" },
				{ id: "i5", title: "Task gone", linkedTaskId: "t9" },
			],
		});
		const tickets = readIdeaTickets(dir, [card("t1")]);
		expect(tickets.map((t) => [t.id, t.state, t.archived])).toEqual([
			["idea:i1", "planned", false],
			["idea:i2", "abandoned", false],
			["idea:i3", "abandoned", true],
			["idea:i5", "planned", false],
		]);
		expect(tickets[0]).toMatchObject({
			spec: "Search is slow\nAdd an index",
			files: ["src/search.ts"],
			updatedAt: "2026-11-02T10:00:00.000Z",
			kind: "idea",
		});
		expect(tickets[1]?.spec).toBe("Cache it");
		expect(tickets[1]).not.toHaveProperty("updatedAt");
	});
});

describe("changeTicket", () => {
	it("reads a squashed pull request, its number and its body without trailers", () => {
		expect(
			changeTicket(
				`\nABCDEF1234567890${F}2026-11-20T10:00:00+01:00${F}feat(kanban): ask the board (#1307)${F}Adds a panel.\n\nCo-Authored-By: X <x@y>\nSigned-off-by: Y`,
			),
		).toEqual({
			id: "change:abcdef1234567890",
			title: "feat(kanban): ask the board (#1307)",
			description: "Adds a panel.",
			spec: "",
			subtasks: [],
			files: [],
			state: "done",
			updatedAt: "2026-11-20T09:00:00.000Z",
			archived: false,
			kind: "change",
			ref: "#1307",
		});
	});

	it("titles a merge commit with its pull request's title, and a plain commit by its short id", () => {
		const merge = changeTicket(
			`abcdef12${F}bad date${F}Merge pull request #42 from owner/branch${F}\nRework the admin page\nNew back-office`,
		);
		expect(merge).toMatchObject({ title: "Rework the admin page", description: "New back-office", ref: "#42" });
		expect(merge).not.toHaveProperty("updatedAt");
		expect(changeTicket(`abcdef1234${F}${F}Fix login${F}`)?.ref).toBe("abcdef12");
	});

	it.each([
		["not a sha", `zzz${F}${F}Fix${F}`],
		["no subject", `abcdef12${F}${F}${F}body`],
		["a branch merge", `abcdef12${F}${F}Merge branch 'develop' into feature${F}`],
		["a dependency bump", `abcdef12${F}${F}build(deps): bump vite${F}`],
		["a Dependabot title", `abcdef12${F}${F}Bump zod from 3 to 4${F}`],
		["a merge without a title", `abcdef12${F}${F}Merge pull request #3 from a/b${F}\n\n`],
		["an empty record", ""],
	])("leaves out %s", (_name, record) => {
		expect(changeTicket(record)).toBeNull();
	});
});

describe("readChangeTickets", () => {
	it("asks git for the branch's first-parent history, bounded, and reads each record", async () => {
		const git = vi.fn(async () => `abcdef12${F}${F}Fix login${F}${R}\nzz${F}${F}x${F}${R}\n`);
		const tickets = await readChangeTickets(dir, git);
		expect(tickets.map((t) => t.title)).toEqual(["Fix login"]);
		expect(git).toHaveBeenCalledWith(dir, [
			"log",
			"--first-parent",
			"--max-count=300",
			`--format=%H${F}%cI${F}%s${F}%b${R}`,
			"HEAD",
		]);
	});

	it("reads nothing when git gives nothing", async () => {
		expect(await readChangeTickets(dir, async () => null)).toEqual([]);
	});

	it("runs git by its path with an argument list, and survives a failure", async () => {
		state.execFile.mockImplementationOnce((_exe, _args, _options, callback) => callback(null, `abcdef12${F}${F}Fix${F}${R}`));
		expect((await readChangeTickets(dir)).map((t) => t.title)).toEqual(["Fix"]);
		const [exe, args, options] = state.execFile.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(exe).toBe("/usr/bin/git");
		expect(args[0]).toBe("log");
		expect(options).toMatchObject({ cwd: dir, timeout: 10_000 });
		expect(options).not.toHaveProperty("shell");

		state.execFile.mockImplementationOnce((_exe, _args, _options, callback) => callback(new Error("not a repo"), ""));
		expect(await readChangeTickets(dir)).toEqual([]);
		state.toolThrows = true;
		expect(await readChangeTickets(dir)).toEqual([]);
	});
});

describe("boardSources", () => {
	it("keeps the sources of the closed list, all of them by default", () => {
		expect(boardSources(undefined)).toEqual(["roadmap", "ideas", "history"]);
		expect(boardSources({ boardAskSources: "all" as never })).toEqual(["roadmap", "ideas", "history"]);
		expect(boardSources({ boardAskSources: ["history", "secrets" as never, "roadmap"] })).toEqual(["roadmap", "history"]);
		expect(boardSources({ boardAskSources: [] })).toEqual([]);
	});

	it("reads them from the settings file, all of them when it cannot", () => {
		state.settings = { boardAskSources: ["ideas"] };
		expect(readBoardSourcesSetting()).toEqual(["ideas"]);
		state.settings = undefined;
		expect(readBoardSourcesSetting()).toEqual(["roadmap", "ideas", "history"]);
		state.settingsThrow = true;
		expect(readBoardSourcesSetting()).toEqual(["roadmap", "ideas", "history"]);
	});
});

describe("readBoardSources", () => {
	it("reads the sources asked only", async () => {
		write(".workpilot/roadmap/roadmap.json", { features: [{ id: "f1", title: "Export" }] });
		write(".workpilot/ideation/ideation.json", { ideas: [{ id: "i1", title: "Search" }] });
		const git = vi.fn(async () => `abcdef12${F}${F}Fix login${F}${R}`);
		expect((await readBoardSources(dir, [], ["roadmap", "ideas", "history"], git)).map((t) => t.id)).toEqual([
			"roadmap:f1",
			"idea:i1",
			"change:abcdef12",
		]);
		expect(await readBoardSources(dir, [], [], git)).toEqual([]);
		expect(git).toHaveBeenCalledTimes(1);
	});
});
