import { describe, expect, it } from "vitest";
import type { Task, VisualProofRun } from "../types/task";
import {
	buildAbandonMetadata,
	buildResumeMetadata,
	computeCompletionChecklist,
	isTaskAbandoned,
} from "./task-lifecycle";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "spec-1",
		specId: "spec-1",
		projectId: "proj-1",
		title: "T",
		description: "",
		status: "human_review",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

const proofWithShot = {
	id: "vp-1",
	status: "passed",
	taskId: "spec-1",
	specId: "spec-1",
	screenshots: [
		{
			label: "Home",
			relativePath: "a.png",
			absolutePath: "/a.png",
			width: 10,
			height: 10,
			capturedAt: new Date().toISOString(),
		},
	],
	startedAt: new Date().toISOString(),
} as VisualProofRun;

const proofNoShot = { ...proofWithShot, screenshots: [] } as VisualProofRun;

describe("computeCompletionChecklist", () => {
	it("is ready when a PR and a captured screenshot both exist", () => {
		const task = makeTask({
			metadata: { prUrl: "https://x/pull/1", visualProof: proofWithShot },
		});
		expect(computeCompletionChecklist(task)).toEqual({
			hasPr: true,
			hasVisualProof: true,
			ready: true,
		});
	});

	it("reads the PR from the top-level field too", () => {
		const task = makeTask({ prUrl: "https://x/pull/2" });
		expect(computeCompletionChecklist(task).hasPr).toBe(true);
	});

	it("is not ready when the PR is missing", () => {
		const task = makeTask({ metadata: { visualProof: proofWithShot } });
		const c = computeCompletionChecklist(task);
		expect(c.hasPr).toBe(false);
		expect(c.ready).toBe(false);
	});

	it("treats a visual-proof run with zero screenshots as missing proof", () => {
		const task = makeTask({
			metadata: { prUrl: "https://x/pull/1", visualProof: proofNoShot },
		});
		const c = computeCompletionChecklist(task);
		expect(c.hasVisualProof).toBe(false);
		expect(c.ready).toBe(false);
	});

	it("is not ready for a bare task", () => {
		expect(computeCompletionChecklist(makeTask()).ready).toBe(false);
	});
});

describe("abandon / resume metadata", () => {
	it("marks abandoned with a timestamp and trimmed reason", () => {
		const now = new Date("2026-07-06T10:00:00.000Z");
		expect(buildAbandonMetadata("  PO deprioritized  ", now)).toEqual({
			abandoned: true,
			abandonedAt: "2026-07-06T10:00:00.000Z",
			abandonedReason: "PO deprioritized",
		});
	});

	it("omits a blank reason", () => {
		const patch = buildAbandonMetadata("   ", new Date());
		expect(patch.abandoned).toBe(true);
		expect("abandonedReason" in patch).toBe(false);
	});

	it("resume clears the abandoned flag and reason", () => {
		expect(buildResumeMetadata()).toEqual({
			abandoned: false,
			abandonedReason: undefined,
		});
	});

	it("isTaskAbandoned reflects the flag (strict true only)", () => {
		expect(isTaskAbandoned(makeTask({ metadata: { abandoned: true } }))).toBe(
			true,
		);
		expect(isTaskAbandoned(makeTask({ metadata: { abandoned: false } }))).toBe(
			false,
		);
		expect(isTaskAbandoned(makeTask())).toBe(false);
	});
});
