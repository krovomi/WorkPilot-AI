/**
 * A scene is a normalized transition of a task: its status or its phase,
 * never a provider's own signal. The model's request carries no title.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types/task";
import {
	NARRATIVE_TITLE_MAX,
	narrativeFor,
	narrativeRequestOf,
	narrativesBetween,
	specNumberOf,
} from "../pixel-office-narratives";

function task(
	status: Task["status"],
	phase?: string,
	overrides: Partial<Task> = {},
): Task {
	return {
		id: "t1",
		specId: "042-dark-mode",
		projectId: "p",
		title: "Dark mode",
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		executionProgress: phase ? ({ phase } as Task["executionProgress"]) : undefined,
		metadata: {
			phaseProviders: {
				spec: "anthropic",
				planning: "anthropic",
				coding: "openai",
				qa: "google",
			},
		},
		...overrides,
	};
}

describe("specNumberOf", () => {
	it("reads the number a spec id starts with", () => {
		expect(specNumberOf("042-dark-mode")).toBe("042");
		expect(specNumberOf("7")).toBe("7");
		expect(specNumberOf("dark-mode")).toBe("");
		expect(specNumberOf("1234567-too-long")).toBe("");
		expect(specNumberOf(undefined)).toBe("");
	});
});

describe("narrativeFor", () => {
	it("hands the plan from the planner to the coder, with their providers", () => {
		expect(
			narrativeFor(task("in_progress", "planning"), task("in_progress", "coding")),
		).toEqual({
			kind: "plan-ready",
			taskId: "t1",
			title: "Dark mode",
			spec: "042",
			from: "planner",
			to: "coder",
			fromFamily: "anthropic",
			toFamily: "openai",
		});
	});

	it("tells the hand-in to QA and the return to the fixer", () => {
		expect(
			narrativeFor(task("in_progress", "coding"), task("in_progress", "qa_review"))
				?.kind,
		).toBe("handed-to-qa");
		const back = narrativeFor(
			task("ai_review", "qa_review"),
			task("ai_review", "qa_fixing"),
		);
		expect(back).toMatchObject({
			kind: "qa-sent-back",
			from: "reviewer",
			to: "fixer",
			fromFamily: "google",
			toFamily: "google",
		});
	});

	it("tells the approval, the delivery and the error", () => {
		const approved = narrativeFor(task("ai_review"), task("human_review"));
		expect(approved).toMatchObject({ kind: "qa-approved", from: "reviewer", to: "you" });
		expect(approved).not.toHaveProperty("toFamily");
		expect(narrativeFor(task("human_review"), task("done"))?.kind).toBe("shipped");
		expect(narrativeFor(task("human_review"), task("pr_created"))?.kind).toBe("shipped");
		expect(narrativeFor(task("in_progress", "qa_review"), task("error"))).toMatchObject({
			kind: "stumbled",
			from: "reviewer",
		});
		expect(narrativeFor(task("in_progress", "complete"), task("error"))).toMatchObject({
			kind: "stumbled",
			from: "coder",
		});
		expect(narrativeFor(task("in_progress"), task("error"))?.from).toBe("coder");
	});

	it("tells nothing for other changes", () => {
		expect(narrativeFor(task("done"), task("pr_created"))).toBeNull();
		expect(narrativeFor(task("backlog"), task("human_review"))).toBeNull();
		expect(narrativeFor(task("backlog"), task("in_progress"))).toBeNull();
		expect(
			narrativeFor(task("in_progress", "coding"), task("in_progress", "coding")),
		).toBeNull();
		expect(
			narrativeFor(task("in_progress", "qa_fixing"), task("in_progress", "qa_review")),
		).toBeNull();
	});

	it("names no provider the task does not name, and bounds the title", () => {
		const long = "x".repeat(NARRATIVE_TITLE_MAX + 50);
		const event = narrativeFor(
			task("in_progress", "planning", { metadata: undefined }),
			task("in_progress", "coding", { metadata: undefined, title: long, specId: "x" }),
		);
		expect(event).not.toHaveProperty("fromFamily");
		expect(event?.title).toHaveLength(NARRATIVE_TITLE_MAX);
		expect(event?.spec).toBe("");
	});
});

describe("narrativesBetween", () => {
	it("tells only tasks it saw before", () => {
		const before = new Map([["t1", task("human_review")]]);
		const events = narrativesBetween(before, [
			task("done"),
			task("done", undefined, { id: "t2" }),
		]);
		expect(events.map((e) => e.taskId)).toEqual(["t1"]);
	});
});

describe("narrativeRequestOf", () => {
	it("keeps the title out of the request and picks the language", () => {
		const event = narrativeFor(task("human_review"), task("done"));
		if (!event) throw new Error("no scene");
		expect(narrativeRequestOf(event, "fr-FR")).toEqual({
			kind: "shipped",
			spec: "042",
			language: "fr",
		});
		expect(narrativeRequestOf(event, "de").language).toBe("en");
	});
});
