/**
 * `.workpilot/review-conventions.md` (#361, lot 2): deduced from the dataset
 * without a model, the same dataset giving the same file, finding titles
 * unable to add markup, and the file written inside the project only.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));

import {
	buildConventions,
	CONVENTIONS_RELATIVE_PATH,
	escapeInline,
	writeConventions,
} from "../review-conventions";
import { parseDataset } from "../review-feedback-dataset";
import { FEEDBACK_RELATIVE_PATH } from "../review-feedback-store";

let root: string;
let project: string;

function dataset(spec: Array<[string, string, string, number, string?]>): string {
	let pr = 0;
	const lines: string[] = [];
	for (const [category, title, verdict, count, reason] of spec) {
		for (let i = 0; i < count; i += 1) {
			pr += 1;
			lines.push(
				JSON.stringify({
					v: 1,
					pr,
					finding_id: `f${pr}`,
					verdict,
					reason: reason ?? null,
					category,
					severity: "low",
					title,
				}),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

const SPEC: Array<[string, string, string, number, string?]> = [
	["style", "Missing docstring on `foo`", "rejected", 6, "too_pedantic"],
	["quality", "Prefer an early return", "not_applicable", 3],
	["quality", "Possible None dereference", "accepted", 4],
	["security", "Hardcoded credential", "rejected", 9],
];

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-conventions-")));
	project = path.join(root, "project");
	mkdirSync(path.join(project, ".workpilot"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("buildConventions", () => {
	it("sorts the kinds of remark into what is dropped, downgraded and kept", () => {
		const { markdown, rules } = buildConventions(parseDataset(dataset(SPEC)), 3);
		expect(rules).toBe(3);
		const [, dropped, downgraded, kept, always] = markdown.split("\n## ");
		expect(dropped).toContain(
			"**style**: Missing docstring on \\`foo\\` (rejected 6, accepted 0; mostly: too pedantic)",
		);
		expect(downgraded).toContain(
			"**quality**: Prefer an early return (rejected 3, accepted 0)",
		);
		expect(kept).toContain("Possible None dereference (rejected 0, accepted 4)");
		expect(always).toContain("never downgraded or dropped");
		expect(markdown).not.toContain("Hardcoded credential");
		expect(markdown).toContain("Deduced from 22 verdict(s) on 4 kind(s)");
	});

	it("gives the same file for the same dataset, whatever the order of kinds", () => {
		const one = buildConventions(parseDataset(dataset(SPEC)), 3).markdown;
		const two = buildConventions(
			parseDataset(dataset([...SPEC].reverse())),
			3,
		).markdown;
		expect(two).toBe(one);
	});

	it("orders the kinds of one category by signature", () => {
		const { markdown } = buildConventions(
			parseDataset(
				dataset([
					["style", "First kind", "rejected", 6],
					["style", "Second kind", "rejected", 6],
				]),
			),
			3,
		);
		const first = markdown.indexOf("First kind");
		const second = markdown.indexOf("Second kind");
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(0);
		const again = buildConventions(
			parseDataset(
				dataset([
					["style", "Second kind", "rejected", 6],
					["style", "First kind", "rejected", 6],
				]),
			),
			3,
		).markdown;
		expect(again).toBe(markdown);
	});

	it("says when a section is empty", () => {
		const { markdown, rules } = buildConventions([], 3);
		expect(rules).toBe(0);
		expect(markdown.match(/None yet\./g)).toHaveLength(3);
	});
});

describe("escapeInline", () => {
	it("keeps a title from adding links, markup or headings", () => {
		expect(escapeInline("[click](http://x) <img src=x> # *bold*\nnext")).toBe(
			"\\[click\\](http://x) \\<img src=x\\> \\# \\*bold\\* next",
		);
	});
});

describe("writeConventions", () => {
	it("writes the file in the project and answers its relative path", () => {
		writeFileSync(path.join(project, FEEDBACK_RELATIVE_PATH), dataset(SPEC));
		const result = writeConventions(project, 3);
		expect(result).toEqual({
			success: true,
			path: ".workpilot/review-conventions.md",
			rules: 3,
		});
		const written = readFileSync(path.join(project, CONVENTIONS_RELATIVE_PATH), "utf-8");
		expect(written).toContain("# Review conventions");
		expect(readdirSync(path.join(project, ".workpilot"))).not.toContain(
			expect.stringMatching(/\.tmp$/),
		);
	});

	it("never writes through a link", () => {
		const target = path.join(root, "outside.md");
		writeFileSync(target, "keep\n");
		try {
			symlinkSync(target, path.join(project, CONVENTIONS_RELATIVE_PATH));
		} catch {
			return; // No symlinks on this machine.
		}
		expect(writeConventions(project, 3)).toEqual({
			success: false,
			error: "write_failed",
		});
		expect(readFileSync(target, "utf-8")).toBe("keep\n");
	});

	it("never writes through a .workpilot link that leaves the project", () => {
		const elsewhere = path.join(root, "elsewhere");
		mkdirSync(elsewhere);
		rmSync(path.join(project, ".workpilot"), { recursive: true });
		try {
			symlinkSync(elsewhere, path.join(project, ".workpilot"), "dir");
		} catch {
			return;
		}
		expect(writeConventions(project, 3).success).toBe(false);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	it("answers write_failed and leaves no temporary file when it cannot write", () => {
		// A folder where the file should be: the rename over it fails.
		mkdirSync(path.join(project, CONVENTIONS_RELATIVE_PATH));
		expect(writeConventions(project, 3)).toEqual({
			success: false,
			error: "write_failed",
		});
		expect(
			readdirSync(path.join(project, ".workpilot")).filter((name) =>
				name.endsWith(".tmp"),
			),
		).toEqual([]);
	});
});
