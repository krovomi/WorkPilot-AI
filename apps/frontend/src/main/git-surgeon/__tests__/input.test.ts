/**
 * What the renderer may send to the Git History Surgeon (#360): checked in
 * main before the runner sees it.
 */
import { describe, expect, it } from "vitest";
import { readBranchNames, readPlanInput, readRevision } from "../input";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("git surgeon input", () => {
	it("takes a revision of a known shape only", () => {
		expect(readRevision("origin/main")).toBe("origin/main");
		expect(readRevision("HEAD~3")).toBe("HEAD~3");
		expect(readRevision("--upload-pack=x")).toBeNull();
		expect(readRevision("main..evil")).toBeNull();
		expect(readRevision(3)).toBeNull();
	});

	it("keeps a plan of shas, messages and paths, nothing else", () => {
		const plan = readPlanInput({
			base: A,
			head: B,
			plan: [{ kind: "squash", sources: [A, B], message: "feat: x", paths: [], extra: "dropped" }],
		});
		expect(plan).toEqual({ base: A, head: B, plan: [{ kind: "squash", sources: [A, B], message: "feat: x", paths: [] }] });
		expect(readPlanInput({ base: A, head: B, plan: [{ kind: "exec", sources: [A], message: "x" }] })).toBeNull();
		expect(readPlanInput({ base: A, head: B, plan: [{ kind: "keep", sources: ["HEAD"], message: "x" }] })).toBeNull();
		expect(readPlanInput({ base: A, head: B, plan: [{ kind: "keep", sources: [A], message: "a\0b" }] })).toBeNull();
		expect(readPlanInput({ base: A, head: B, branch: "-x", plan: [{ kind: "keep", sources: [A], message: "x" }] })).toBeNull();
		expect(readPlanInput({ base: "main", head: B, plan: [] })).toBeNull();
	});

	it("takes branch names git could accept", () => {
		expect(readBranchNames(["feat/a", "done"])).toEqual(["feat/a", "done"]);
		expect(readBranchNames(["-D"])).toBeNull();
		expect(readBranchNames(["a..b"])).toBeNull();
		expect(readBranchNames([])).toBeNull();
	});
});
