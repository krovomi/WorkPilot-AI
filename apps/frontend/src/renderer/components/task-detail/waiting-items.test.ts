import { describe, expect, it } from "vitest";
import type { PrFollowupStatus, Task, TaskPipelineStatus } from "../../../shared/types";
import { PANEL_CARDS, PANEL_SECTIONS, sectionOfCard } from "./panel-sections";
import { collectWaitingItems, type WaitingInput } from "./waiting-items";

const base = { id: "t1", specId: "001", status: "backlog" } as unknown as Task;
type Input = Partial<Omit<WaitingInput, "task">> & { task?: Partial<Task> };
const ids = ({ task, ...rest }: Input) =>
	collectWaitingItems({
		hasPermissionQuestion: false,
		...rest,
		task: { ...base, ...task } as Task,
	}).map((item) => item.id);

const pipeline = (patch: Partial<TaskPipelineStatus>): TaskPipelineStatus => ({
	taskId: "t1",
	projectId: "p1",
	state: "failed",
	checkedAt: "2026-11-02T08:00:00Z",
	...patch,
});

const round = (patch: Partial<NonNullable<PrFollowupStatus["round"]>>): PrFollowupStatus => ({
	running: false,
	round: {
		decision: "fix",
		reason: "",
		action: "none",
		head_sha: "",
		pushed_sha: "",
		detail: "",
		failing: [],
		base_failing: [],
		threads: [],
		violations: [],
		finished: true,
		...patch,
	},
});

describe("collectWaitingItems", () => {
	it("is empty for a task that needs nobody", () => {
		expect(ids({})).toEqual([]);
		expect(ids({ task: { status: "in_progress" } })).toEqual([]);
	});

	it("asks for the plan, and only the plan, on a plan review", () => {
		expect(ids({ task: { status: "human_review", reviewReason: "plan_review" } })).toEqual(["plan"]);
	});

	it("asks for a review of finished work", () => {
		for (const reviewReason of ["completed", "qa_rejected", "qa_unverified", "stopped"] as const) {
			expect(ids({ task: { status: "human_review", reviewReason } })).toEqual(["review"]);
		}
	});

	it("says a build failed, pointing at the failure banner", () => {
		expect(ids({ task: { status: "error" } })).toEqual(["failed"]);
		const items = collectWaitingItems({
			task: { ...base, status: "human_review", reviewReason: "errors" } as Task,
			hasPermissionQuestion: false,
		});
		expect(items).toEqual([{ id: "failed", target: "failure" }]);
	});

	it("puts an agent's question first", () => {
		expect(
			ids({ hasPermissionQuestion: true, task: { status: "human_review", reviewReason: "plan_review" } }),
		).toEqual(["permission", "plan"]);
	});

	it("says CI is red, unless a repair is already running", () => {
		expect(ids({ pipeline: pipeline({}) })).toEqual(["ci"]);
		expect(ids({ pipeline: pipeline({ autoFixInProgress: true }) })).toEqual([]);
		expect(ids({ pipeline: pipeline({ state: "succeeded" }) })).toEqual([]);
	});

	it("says the PR checks are red once the follow-through is not fixing them", () => {
		const task = { metadata: { prUrl: "https://example.test/pr/1" } } as Partial<Task>;
		expect(ids({ task, prFollowup: round({ failing: ["unit"] }) })).toEqual(["prChecks"]);
		expect(ids({ task, prFollowup: round({ decision: "exhausted" }) })).toEqual(["prChecks"]);
		expect(ids({ task, prFollowup: { ...round({ failing: ["unit"] }), running: true } })).toEqual([]);
		expect(ids({ task, prFollowup: round({ decision: "green" }) })).toEqual([]);
		// No PR on the task any more: nothing to send the person to.
		expect(ids({ prFollowup: round({ failing: ["unit"] }) })).toEqual([]);
	});

	it("says the goal is not met once no agent works on the task", () => {
		const goal = { status: "unmet", reason: "exit 1" } as const;
		expect(ids({ task: { status: "done", goal } })).toEqual(["goal"]);
		expect(ids({ task: { status: "in_progress", goal } })).toEqual([]);
		expect(ids({ task: { status: "done", goal: { status: "met", reason: "" } } })).toEqual([]);
	});

	it("points every item at a card that exists in a tab", () => {
		const items = collectWaitingItems({
			task: { ...base, status: "human_review", reviewReason: "completed", goal: { status: "budget", reason: "" }, metadata: { prUrl: "u" } } as Task,
			hasPermissionQuestion: true,
			pipeline: pipeline({}),
			prFollowup: round({ failing: ["x"] }),
		});
		const cards = PANEL_SECTIONS.flatMap((section) => PANEL_CARDS[section]);
		for (const item of items) {
			if (item.target !== "failure") expect(cards).toContain(item.target);
		}
		expect(items.map((item) => item.id)).toEqual(["permission", "ci", "prChecks", "goal", "review"]);
	});
});

describe("panel sections", () => {
	it("puts every card in exactly one tab", () => {
		const cards = PANEL_SECTIONS.flatMap((section) => PANEL_CARDS[section]);
		expect(new Set(cards).size).toBe(cards.length);
		expect(sectionOfCard("goal")).toBe("progress");
		expect(sectionOfCard("verifyLoop")).toBe("quality");
		expect(sectionOfCard("rtk")).toBe("costs");
	});
});
