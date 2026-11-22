/**
 * A task carries where its full suite runs (`test_placement.json`) and the
 * suite sent to the forge's CI (`plan.ciSuite`), for the card's badge and
 * the merge held while the CI runs. Malformed records are left out.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDir: string;

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn((name: string) =>
			name === "userData" ? path.join(testDir, "userData") : testDir,
		),
	},
}));

const SHA = "b".repeat(40);

function writeSpec(project: string, name: string, plan: Record<string, unknown>, placement?: unknown) {
	const specDir = path.join(project, ".workpilot", "specs", name);
	mkdirSync(specDir, { recursive: true });
	writeFileSync(
		path.join(specDir, "implementation_plan.json"),
		JSON.stringify({
			feature: name,
			workflow_type: "feature",
			status: "human_review",
			phases: [],
			final_acceptance: [],
			created_at: "2026-11-01T00:00:00Z",
			updated_at: "2026-11-02T00:00:00Z",
			spec_file: "spec.md",
			...plan,
		}),
		"utf-8",
	);
	writeFileSync(path.join(specDir, "spec.md"), `# ${name}\n`, "utf-8");
	if (placement !== undefined) {
		writeFileSync(path.join(specDir, "test_placement.json"), JSON.stringify(placement), "utf-8");
	}
}

describe("ProjectStore reads the suite placement", () => {
	beforeEach(() => {
		testDir = mkdtempSync(path.join(tmpdir(), "project-store-suite-"));
		mkdirSync(path.join(testDir, "userData", "store"), { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps well-formed records and leaves out the rest", async () => {
		const project = path.join(testDir, "project");
		mkdirSync(project, { recursive: true });
		const ciSuite = {
			state: "pending",
			branch: "workpilot/001-sent",
			sha: SHA,
			pushedAt: "2026-11-22T10:00:00Z",
		};
		const placement = {
			target: "ci",
			reason: "branch_push",
			mode: "auto",
			short: ["ram"],
			facts: { cores: 8 },
		};
		writeSpec(project, "001-sent", { ciSuite }, placement);
		writeSpec(project, "002-garbled", { ciSuite: { ...ciSuite, branch: "main" } }, { target: "moon" });
		writeSpec(project, "003-none", {});

		const { ProjectStore } = await import("../project-store");
		const store = new ProjectStore();
		const { id } = store.addProject(project);
		const bySpec = Object.fromEntries(
			store.getTasks(id).map((task) => [task.specId, [task.ciSuite, task.suitePlacement]]),
		);

		expect(bySpec["001-sent"]).toEqual([ciSuite, expect.objectContaining({ target: "ci", short: ["ram"] })]);
		expect(bySpec["002-garbled"]).toEqual([undefined, undefined]);
		expect(bySpec["003-none"]).toEqual([undefined, undefined]);
	});
});
