/**
 * A reset that cannot be appended answers write_failed (#361, lot 2): the
 * append is made to fail, everything else is the real file system.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: () => {
			throw new Error("disk full");
		},
	};
});
vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));

import { signature } from "../review-feedback-dataset";
import { FEEDBACK_RELATIVE_PATH, recordReset } from "../review-feedback-store";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-reset-fail-")));
	mkdirSync(path.join(root, ".workpilot"));
	writeFileSync(
		path.join(root, FEEDBACK_RELATIVE_PATH),
		`${JSON.stringify({
			v: 1,
			pr: 1,
			finding_id: "f-1",
			verdict: "rejected",
			category: "style",
			severity: "low",
			title: "Nit",
		})}\n`,
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

it("answers write_failed when the reset line cannot be appended", () => {
	expect(recordReset(root, signature("style", "Nit"))).toBe("write_failed");
});
