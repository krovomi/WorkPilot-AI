/**
 * A task carries the QA reviewer's last sign-off from its plan, so the
 * renderer can tell a task that passed QA on its first session (Pixel Office
 * achievements) without reading the plan itself.
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

function writeSpec(project: string, name: string, plan: Record<string, unknown>) {
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
}

describe("ProjectStore reads the QA sign-off", () => {
	beforeEach(() => {
		testDir = mkdtempSync(path.join(tmpdir(), "project-store-qa-"));
		mkdirSync(path.join(testDir, "userData", "store"), { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps a well-formed sign-off and leaves out the rest", async () => {
		const project = path.join(testDir, "project");
		mkdirSync(project, { recursive: true });
		writeSpec(project, "001-first-try", {
			qa_signoff: { status: "approved", qa_session: 1, issues_found: [] },
		});
		writeSpec(project, "002-garbled", {
			qa_signoff: { status: "approved", qa_session: "1" },
		});
		writeSpec(project, "003-none", {});

		const { ProjectStore } = await import("../project-store");
		const store = new ProjectStore();
		const { id } = store.addProject(project);
		const bySpec = Object.fromEntries(
			store.getTasks(id).map((task) => [task.specId, task.qaSignoff]),
		);

		expect(bySpec).toEqual({
			"001-first-try": { status: "approved", session: 1 },
			"002-garbled": undefined,
			"003-none": undefined,
		});
	});
});
