import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, ApprovalStore } from "../approvals";

describe("ApprovalStore", () => {
	it("approves once", () => {
		const store = new ApprovalStore();
		const token = store.issue("t1", "approve_plan");
		expect(store.consume(token)).toEqual({ taskId: "t1", action: "approve_plan" });
		expect(store.consume(token)).toBeNull();
	});

	it("refuses an expired token", () => {
		let now = 1_000;
		const store = new ApprovalStore(() => now);
		const token = store.issue("t1", "approve_plan");
		now += APPROVAL_TTL_MS;
		expect(store.consume(token)).toBeNull();
	});

	it("refuses a token it did not issue", () => {
		expect(new ApprovalStore().consume("made-up")).toBeNull();
	});

	it("voids the old button when a new one is issued for the same task", () => {
		const store = new ApprovalStore();
		const first = store.issue("t1", "approve_plan");
		const second = store.issue("t1", "approve_plan");
		expect(store.consume(first)).toBeNull();
		expect(store.consume(second)?.taskId).toBe("t1");
	});

	it("voids every token of a task that left plan review", () => {
		const store = new ApprovalStore();
		const token = store.issue("t1", "approve_plan");
		const other = store.issue("t2", "approve_plan");
		store.revoke("t1");
		expect(store.consume(token)).toBeNull();
		expect(store.consume(other)?.taskId).toBe("t2");
	});

	it("issues tokens that fit Telegram's callback data", () => {
		const token = new ApprovalStore().issue("t1", "approve_plan");
		expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(Buffer.byteLength(`approve:${token}`)).toBeLessThanOrEqual(64);
	});
});
