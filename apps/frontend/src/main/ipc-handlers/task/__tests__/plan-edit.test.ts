/**
 * Plan edits from the Subtasks tab are merged into the plan's own phases: the
 * planner's phases and every subtask the build has started stay as they are.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlanEdit, parsePlanEdit } from "../plan-edit";
import { updatePlanSubtasks } from "../plan-file-utils";

vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));

type Entry = Record<string, unknown>;
type Phases = Array<Entry & { subtasks: Entry[]; chunks: Entry[] }>;

/** A plan as the planner writes it; the cast lets a test read either list. */
function plan(): { feature: string; phases: Phases } {
	const written = {
		feature: "Login",
		phases: [
			{
				id: "phase-1",
				name: "Backend",
				depends_on: [],
				subtasks: [
					{ id: "1.1", description: "Add the route", status: "completed", files_changed: ["api.py"] },
					{
						id: "1.2",
						description: "Add the model",
						status: "pending",
						files_to_modify: ["models.py", "db.py"],
						files_to_create: ["schema.py"],
					},
				],
			},
			{
				id: "phase-2",
				name: "Frontend",
				depends_on: ["phase-1"],
				chunks: [
					{ id: "2.1", description: "Add the form", status: "pending", files: ["Form.tsx"] },
					{ id: "2.2", description: "Wire it", status: "in_progress" },
				],
			},
		],
	};
	return written as unknown as { feature: string; phases: Phases };
}

const ui = (id: string, description: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: description,
	description,
	status: "pending",
	...extra,
});

describe("parsePlanEdit", () => {
	it("reads every subtask the renderer sent, with its text", () => {
		expect(
			parsePlanEdit([
				{ name: "Implementation", subtasks: [ui("1.2", "  Add the user model "), { id: "x", title: "Only a title" }] },
				{ name: "More", subtasks: [{ id: "new-1", files: ["a.ts"] }] },
			]),
		).toEqual([
			{ id: "1.2", description: "Add the user model" },
			{ id: "x", description: "Only a title" },
			{ id: "new-1", description: "", files: ["a.ts"] },
		]);
	});

	it.each([
		["not a list", { phases: [] }],
		["a phase without subtasks", [{ name: "P" }]],
		["a subtask that is not an object", [{ subtasks: ["1.1"] }]],
		["an id that cannot name a subtask", [{ subtasks: [{ id: "../../x" }] }]],
		["a missing id", [{ subtasks: [{ description: "x" }] }]],
		["the same id twice", [{ subtasks: [{ id: "a" }, { id: "a" }] }]],
		["a text that is not a string", [{ subtasks: [{ id: "a", description: 3 }] }]],
		["a text too long", [{ subtasks: [{ id: "a", description: "x".repeat(10_001) }] }]],
		["files that are not a list of paths", [{ subtasks: [{ id: "a", files: [1] }] }]],
		["too many files", [{ subtasks: [{ id: "a", files: Array(1_001).fill("f") }] }]],
		["too many subtasks", [{ subtasks: Array.from({ length: 501 }, (_, i) => ({ id: `s${i}` })) }]],
	])("refuses %s", (_label, phases) => {
		expect(parsePlanEdit(phases)).toBeNull();
	});
});

describe("applyPlanEdit", () => {
	it("keeps the phases and the started subtasks when a pending one is reworded", () => {
		const before = plan();
		const after = applyPlanEdit(before, [
			{ id: "1.1", description: "Rewritten by the renderer" },
			{ id: "1.2", description: "Add the user model", files: ["models.py", "schema.py"] },
			{ id: "2.1", description: "Add the form" },
			{ id: "2.2", description: "" },
		]);
		expect(after.feature).toBe("Login");
		const [backend, frontend] = after.phases as Phases;
		expect(backend).toMatchObject({ id: "phase-1", name: "Backend", depends_on: [] });
		expect(backend.subtasks[0]).toEqual(before.phases[0].subtasks[0]);
		expect(backend.subtasks[1]).toEqual({
			id: "1.2",
			description: "Add the user model",
			status: "pending",
			files_to_modify: ["models.py"],
			files_to_create: ["schema.py"],
		});
		expect(frontend).toMatchObject({ id: "phase-2", depends_on: ["phase-1"] });
		expect(frontend.chunks?.map((s) => s.id)).toEqual(["2.1", "2.2"]);
		expect(frontend).not.toHaveProperty("subtasks");
		expect(before.phases[0].subtasks[1].description).toBe("Add the model");
	});

	it("removes the pending subtasks left out, never a started one", () => {
		const after = applyPlanEdit(plan(), [{ id: "2.1", description: "" }]);
		const phases = after.phases as Phases;
		expect(phases[0].subtasks.map((s) => s.id)).toEqual(["1.1"]);
		expect(phases[1].chunks?.map((s) => s.id)).toEqual(["2.1", "2.2"]);
		expect(phases[1].chunks?.[0].description).toBe("Add the form");
	});

	it("adds a new subtask with text at the end of the last phase", () => {
		const after = applyPlanEdit(plan(), [
			{ id: "1.2", description: "Add the model" },
			{ id: "new-1", description: "Write the docs" },
			{ id: "new-2", description: "" },
		]);
		const chunks = (after.phases as Phases)[1].chunks ?? [];
		expect(chunks.at(-1)).toEqual({
			id: "new-1",
			description: "Write the docs",
			status: "pending",
			files_to_modify: [],
		});
		expect(chunks.map((s) => s.id)).not.toContain("new-2");
	});

	it("keeps a change request's summary in step with its text", () => {
		const after = applyPlanEdit(
			{ phases: [{ name: "Implementation", subtasks: [{ id: "cr", title: "Old", description: "Old", status: "pending" }] }] },
			[{ id: "cr", description: `Rename it\nand the tests ${"x".repeat(200)}` }],
		);
		const [subtask] = (after.phases as Array<{ subtasks: Array<{ title: string }> }>)[0].subtasks;
		expect(subtask.title).toBe("Rename it");
	});

	it("puts a new subtask in a phase of its own when the plan has none", () => {
		expect(applyPlanEdit({}, [{ id: "a", description: "First" }]).phases).toEqual([
			{ name: "Implementation", subtasks: [{ id: "a", description: "First", status: "pending", files_to_modify: [] }] },
		]);
		const odd = applyPlanEdit({ phases: [{ name: "Empty" }, "junk"] }, [{ id: "a", description: "First" }]);
		expect(odd.phases).toEqual([
			{ name: "Empty", subtasks: [{ id: "a", description: "First", status: "pending", files_to_modify: [] }] },
			"junk",
		]);
	});

	it("leaves an entry that is not a subtask where it is", () => {
		const after = applyPlanEdit({ phases: [{ subtasks: ["note", { status: "pending" }] }] }, []);
		expect(after.phases).toEqual([{ subtasks: ["note"] }]);
	});
});

describe("updatePlanSubtasks", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("writes the merged plan to disk", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "plan-edit-"));
		const planPath = path.join(dir, "implementation_plan.json");
		writeFileSync(planPath, JSON.stringify(plan()), "utf-8");
		const edits = parsePlanEdit([{ name: "Implementation", subtasks: [ui("1.2", "Add the user model")] }]);
		expect(edits).not.toBeNull();
		const updated = await updatePlanSubtasks(planPath, edits ?? [], "p1");
		const onDisk = JSON.parse(readFileSync(planPath, "utf-8"));
		expect(onDisk).toEqual(updated);
		expect(onDisk.phases.map((p: { name: string }) => p.name)).toEqual(["Backend", "Frontend"]);
		expect(onDisk.phases[0].subtasks[1].description).toBe("Add the user model");
		expect(onDisk.phases[1].chunks.map((s: { id: string }) => s.id)).toEqual(["2.2"]);
		expect(await updatePlanSubtasks(path.join(dir, "missing.json"), [])).toBeNull();
	});
});
