import { describe, expect, it } from "vitest";
import { message, needsYouKind, remotelyApprovable, reply, testMessage } from "../events";

describe("needsYouKind", () => {
	it("calls a plan waiting for approval a plan review, never a failure", () => {
		expect(needsYouKind("plan_review", "plan_review")).toBe("plan_review");
		expect(needsYouKind("human_review", "plan_review")).toBe("plan_review");
	});

	it("names each review reason", () => {
		expect(needsYouKind("human_review", "completed")).toBe("completed");
		expect(needsYouKind("human_review", "qa_rejected")).toBe("qa_rejected");
		expect(needsYouKind("human_review", "qa_unverified")).toBe("qa_unverified");
		expect(needsYouKind("human_review", "errors")).toBe("failed");
		expect(needsYouKind("error", "errors")).toBe("failed");
	});

	it("stays quiet for a task the person stopped, and for running states", () => {
		expect(needsYouKind("human_review", "stopped")).toBeNull();
		for (const state of ["backlog", "planning", "coding", "qa_review", "qa_fixing", "done", "pr_created"]) {
			expect(needsYouKind(state, undefined)).toBeNull();
		}
	});
});

describe("remotelyApprovable", () => {
	it("allows a plan approval only: a finished task's review leads to a merge", () => {
		expect(remotelyApprovable("plan_review")).toBe(true);
		for (const kind of ["completed", "qa_rejected", "qa_unverified", "failed"] as const) {
			expect(remotelyApprovable(kind)).toBe(false);
		}
	});
});

describe("message", () => {
	const failed = {
		kind: "failed" as const,
		taskId: "t1",
		projectId: "p1",
		taskTitle: "Add login",
		detail: "Traceback: /home/me/secret/path",
	};

	it("speaks the app's language", () => {
		expect(message({ ...failed, kind: "plan_review" }, "fr").title).toBe("Un plan t'attend");
		expect(message({ ...failed, kind: "plan_review" }, "en-US").title).toBe("Plan waiting for you");
		expect(message(failed, "fr").body).toContain("« Add login »");
	});

	it("keeps the error detail off remote channels", () => {
		expect(message(failed, "en").body).not.toContain("Traceback");
		expect(message(failed, "en", true).body).toContain("Traceback");
	});

	it("has replies and a test message in both languages", () => {
		expect(reply("approved", "fr")).toMatch(/Approuvé/);
		expect(reply("expired", "en")).toMatch(/expired/);
		expect(testMessage("fr").title).toBe("Test WorkPilot");
	});
});
