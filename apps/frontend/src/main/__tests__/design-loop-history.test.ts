/**
 * The render loop's figures stay in the project, on this computer: a line per
 * loop that ran, the hash of each file a write put on a review card, and the
 * figures read back from both, each line checked and each path kept inside
 * the project.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	afterMkdir: null as null | (() => void),
	/** Windows has no O_NOFOLLOW. */
	noFollow: true,
}));
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const constants = Object.create(real.constants, {
		O_NOFOLLOW: { get: () => (hooks.noFollow ? real.constants.O_NOFOLLOW : undefined) },
	});
	return {
		...real,
		constants,
		mkdirSync: (...args: Parameters<typeof real.mkdirSync>) => {
			const made = real.mkdirSync(...args);
			const hook = hooks.afterMkdir;
			hooks.afterMkdir = null;
			hook?.();
			return made;
		},
	};
});
vi.mock("../project-store", () => ({
	projectStore: { getProject: () => undefined, getProjects: () => [] },
}));

import {
	LOOP_HISTORY,
	WRITE_HISTORY,
	loopLine,
	loopStats,
	recordLoop,
	recordWrite,
	sha256,
} from "../design-loop-history";

let root: string;
let project: string;
const NOW = new Date("2026-11-22T10:00:00Z");

const report = (status: string, scores: number[], extra: Record<string, unknown> = {}) => ({
	status,
	best_iteration: scores.indexOf(Math.max(...scores)),
	iterations: scores.map((score, index) => ({ index, score })),
	route: "openai",
	...extra,
});

const lines = (relative: string) =>
	readFileSync(path.join(project, relative), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

const worktreeOf = (specId: string) =>
	path.join(project, ".workpilot", "worktrees", "tasks", specId);

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "dtc-history-")));
	project = path.join(root, "project");
	mkdirSync(project);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loopLine", () => {
	it("keeps the status, the score kept, the corrections and the route", () => {
		expect(loopLine(report("converged", [0.7, 0.96, 0.9]), NOW)).toEqual({
			at: NOW.toISOString(),
			status: "converged",
			best_score: 0.96,
			iterations: 2,
			route: "openai",
		});
	});

	it("leaves out a loop that did not run or measured nothing", () => {
		expect(loopLine(null)).toBeNull();
		expect(loopLine({ status: "skipped", iterations: [] })).toBeNull();
		expect(loopLine({ status: "converged", iterations: [] })).toBeNull();
		expect(loopLine({ status: "converged" })).toBeNull();
		expect(loopLine({ status: "converged", iterations: ["odd"] })).toBeNull();
		expect(loopLine({ status: "converged", iterations: [{ score: Number.NaN }] })).toBeNull();
	});

	it("bounds what came from the runner", () => {
		const line = loopLine({
			status: "stalled",
			best_iteration: "1",
			iterations: [{ score: 1.4 }],
			route: "../../etc",
		});
		expect(line).toMatchObject({ best_score: 1, iterations: 0, route: "" });
		expect(loopLine({ status: "failed", iterations: [{ score: -1 }] })?.best_score).toBe(0);
	});
});

describe("the journals", () => {
	it("append one line per loop that ran, and none for a skip", () => {
		recordLoop(project, report("converged", [0.8, 0.97]));
		recordLoop(project, { status: "skipped", reason: "no_browser", iterations: [] });
		recordLoop(project, report("max_iterations", [0.6, 0.7]));
		expect(lines(LOOP_HISTORY).map((l) => l.status)).toEqual(["converged", "max_iterations"]);
	});

	it("append on a system without O_NOFOLLOW too", () => {
		hooks.noFollow = false;
		try {
			recordLoop(project, report("converged", [0.99]));
		} finally {
			hooks.noFollow = true;
		}
		expect(lines(LOOP_HISTORY)).toHaveLength(1);
	});

	it("append the hash of each file written on a card", () => {
		recordWrite(project, "001-design", [{ path: "src/A.tsx", content: "a" }], NOW);
		expect(lines(WRITE_HISTORY)).toEqual([
			{
				at: NOW.toISOString(),
				specId: "001-design",
				files: [{ path: "src/A.tsx", sha256: sha256("a") }],
			},
		]);
	});

	it("record nothing for a card id that is not one, or no file", () => {
		recordWrite(project, "../escape", [{ path: "a", content: "a" }]);
		recordWrite(project, "001-design", []);
		expect(existsSync(path.join(project, WRITE_HISTORY))).toBe(false);
	});

	it("never write through a link that leaves the project, and never throw", () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(project, ".workpilot"), "dir");
		recordLoop(project, report("converged", [0.99]));
		recordWrite(project, "001-design", [{ path: "a", content: "a" }]);
		expect(existsSync(path.join(outside, "design-to-code"))).toBe(false);
	});

	it("never append to a journal that is not a plain file", () => {
		mkdirSync(path.join(project, LOOP_HISTORY), { recursive: true });
		expect(() => recordLoop(project, report("converged", [0.99]))).not.toThrow();
		mkdirSync(path.join(project, WRITE_HISTORY, "x"), { recursive: true });
		expect(() =>
			recordWrite(project, "001-design", [{ path: "a", content: "a" }]),
		).not.toThrow();
	});

	it("skip a write whose folder was swapped for a link while it was made", () => {
		const outside = path.join(root, "outside");
		mkdirSync(path.join(outside, "design-to-code"), { recursive: true });
		hooks.afterMkdir = () => {
			rmSync(path.join(project, ".workpilot"), { recursive: true });
			symlinkSync(outside, path.join(project, ".workpilot"), "dir");
		};
		recordLoop(project, report("converged", [0.99]));
		expect(existsSync(path.join(outside, "design-to-code", "loop-history.jsonl"))).toBe(false);
	});
});

describe("loopStats", () => {
	it("is empty without a project or a journal", () => {
		const empty = {
			loops: 0,
			converged: 0,
			averageScore: null,
			averageIterations: null,
			writes: 0,
			kept: 0,
			pending: 0,
			retouched: 0,
		};
		expect(loopStats(null)).toEqual(empty);
		expect(loopStats(project)).toEqual(empty);
		expect(loopStats(path.join(root, "gone"))).toEqual(empty);
	});

	it("averages the score of every loop and the corrections of the converged ones", () => {
		recordLoop(project, report("converged", [0.8, 0.9, 0.96]));
		recordLoop(project, report("converged", [0.9, 1]));
		recordLoop(project, report("stalled", [0.5, 0.62]));
		const stats = loopStats(project);
		expect(stats).toMatchObject({ loops: 3, converged: 2, averageIterations: 1.5 });
		expect(stats.averageScore).toBeCloseTo((0.96 + 1 + 0.62) / 3);
	});

	it("leaves out the lines that are not the journal's", () => {
		mkdirSync(path.dirname(path.join(project, LOOP_HISTORY)), { recursive: true });
		const good = JSON.stringify({ status: "converged", best_score: 0.97, iterations: 1 });
		writeFileSync(
			path.join(project, LOOP_HISTORY),
			[
				"not json",
				"[]",
				JSON.stringify({ status: "skipped", best_score: 0.5, iterations: 0 }),
				JSON.stringify({ status: "converged", best_score: 2, iterations: 0 }),
				JSON.stringify({ status: "converged", best_score: 0.9, iterations: -1 }),
				good,
				"",
			].join("\n"),
		);
		expect(loopStats(project)).toMatchObject({ loops: 1, averageScore: 0.97 });
	});

	it("tells a kept write from one waiting on its card and one retouched", () => {
		writeFileSync(path.join(project, "Kept.tsx"), "kept");
		recordWrite(project, "001-kept", [{ path: "Kept.tsx", content: "kept" }]);

		mkdirSync(worktreeOf("002-review"), { recursive: true });
		writeFileSync(path.join(worktreeOf("002-review"), "Wait.tsx"), "wait");
		recordWrite(project, "002-review", [{ path: "Wait.tsx", content: "wait" }]);

		mkdirSync(worktreeOf("003-edited"), { recursive: true });
		writeFileSync(path.join(worktreeOf("003-edited"), "Edit.tsx"), "edited by hand");
		recordWrite(project, "003-edited", [{ path: "Edit.tsx", content: "as written" }]);

		recordWrite(project, "004-gone", [{ path: "Gone.tsx", content: "gone" }]);
		expect(loopStats(project)).toMatchObject({ writes: 4, kept: 1, pending: 1, retouched: 2 });
	});

	it("counts a file outside the project, too large or of another shape as retouched", () => {
		const outside = path.join(root, "outside.tsx");
		writeFileSync(outside, "x");
		symlinkSync(outside, path.join(project, "Linked.tsx"));
		recordWrite(project, "001-a", [{ path: "Linked.tsx", content: "x" }]);
		recordWrite(project, "002-b", [{ path: "../outside.tsx", content: "x" }]);
		const big = "y".repeat(1024 * 1024 + 1);
		writeFileSync(path.join(project, "Big.tsx"), big);
		recordWrite(project, "003-c", [{ path: "Big.tsx", content: big }]);
		mkdirSync(path.join(project, "Folder.tsx"));
		recordWrite(project, "004-d", [{ path: "Folder.tsx", content: "" }]);
		expect(loopStats(project)).toMatchObject({ writes: 4, kept: 0, retouched: 4 });
	});

	it("reads only well-formed write lines", () => {
		mkdirSync(path.dirname(path.join(project, WRITE_HISTORY)), { recursive: true });
		const file = { path: "A.tsx", sha256: sha256("a") };
		writeFileSync(
			path.join(project, WRITE_HISTORY),
			[
				JSON.stringify("odd"),
				JSON.stringify({ specId: "../x", files: [file] }),
				JSON.stringify({ specId: "001", files: "A.tsx" }),
				JSON.stringify({ specId: "001", files: [] }),
				JSON.stringify({ specId: "001", files: [{ path: "A.tsx", sha256: "nope" }] }),
				JSON.stringify({ specId: "001", files: ["A.tsx"] }),
				JSON.stringify({ specId: "001", files: [{ path: "", sha256: sha256("a") }] }),
				JSON.stringify({ specId: "001", files: [file] }),
			].join("\n"),
		);
		writeFileSync(path.join(project, "A.tsx"), "a");
		expect(loopStats(project)).toMatchObject({ writes: 1, kept: 1 });
	});

	it("reads a long journal from its end", () => {
		mkdirSync(path.dirname(path.join(project, LOOP_HISTORY)), { recursive: true });
		const line = JSON.stringify({ status: "converged", best_score: 0.99, iterations: 1 });
		const padding = `${"x".repeat(2 * 1024 * 1024)}\n`;
		writeFileSync(path.join(project, LOOP_HISTORY), `${padding}${`${line}\n`.repeat(600)}`);
		expect(loopStats(project).loops).toBe(500);
	});
});
