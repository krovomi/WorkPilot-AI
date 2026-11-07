/**
 * The subtask panel's answers to a blocked subtask, applied to a plan the way
 * the backend applies them (`apps/backend/foundation/subtask_unblock.py`):
 * the same fields, the same refusals.
 */

import { describe, expect, it } from "vitest";
import {
	UnblockRefused,
	applyUnblock,
	subtaskBlockFields,
} from "../subtask-unblock";

function plan(subtask: Record<string, unknown>): Record<string, unknown> {
	return {
		status: "human_review",
		planStatus: "review",
		qa_signoff: { status: "approved" },
		phases: [{ name: "Implementation", subtasks: [subtask] }],
	};
}

function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof UnblockRefused ? error.code : String(error);
	}
	return "applied";
}

describe("applyUnblock", () => {
	it("closes the subtask for done and not needed, keeping the reason", () => {
		for (const action of ["complete", "skip"]) {
			const p = plan({ id: "v", status: "blocked", _blocked_reason: "Check it" });
			const subtask = applyUnblock(p, "v", action, undefined, "T");
			expect(subtask.status).toBe("completed");
			expect(subtask.human_resolution).toEqual({ action, at: "T", reason: "Check it" });
			expect(subtask).not.toHaveProperty("_blocked_reason");
			expect(p.status).toBe("human_review");
		}
	});

	it("sends it back to the agent for retry and reply, and reopens the plan", () => {
		const p = plan({ id: "v", status: "failed", blocked_kind: "max_attempts" });
		const subtask = applyUnblock(p, "v", "answer", "  In src/  ", "T");
		expect(subtask).toMatchObject({
			status: "pending",
			human_reply: "In src/",
			unblocked_at: "T",
		});
		expect(subtask).not.toHaveProperty("blocked_kind");
		expect(p).toMatchObject({ status: "in_progress", planStatus: "in_progress" });
		expect((p.qa_signoff as { status: string }).status).toBe("pending");
	});

	it("refuses an answer that cannot apply", () => {
		const blocked = () => plan({ id: "v", status: "blocked" });
		expect(refusal(() => applyUnblock(blocked(), "v", "delete"))).toBe("invalid_action");
		expect(refusal(() => applyUnblock(blocked(), "v", "answer", " "))).toBe("reply_required");
		expect(refusal(() => applyUnblock(blocked(), "v", "answer", "x".repeat(4001)))).toBe(
			"reply_too_long",
		);
		expect(refusal(() => applyUnblock(blocked(), "nope", "complete"))).toBe(
			"subtask_not_found",
		);
		expect(
			refusal(() => applyUnblock(plan({ id: "v", status: "completed" }), "v", "skip")),
		).toBe("not_blocked");
	});
});

describe("subtaskBlockFields", () => {
	it("reads the reason older agents wrote and drops an unknown kind", () => {
		expect(subtaskBlockFields({ _blocked_reason: " Old ", blocked_kind: "weird" })).toEqual({
			blockedReason: "Old",
		});
		expect(
			subtaskBlockFields({
				blocked_reason: "Needs a phone",
				blocked_kind: "needs_human",
				human_reply: "done",
				human_resolution: { action: "skip", at: "T" },
			}),
		).toEqual({
			blockedReason: "Needs a phone",
			blockedKind: "needs_human",
			humanReply: "done",
			humanResolution: { action: "skip", at: "T" },
		});
	});
});
