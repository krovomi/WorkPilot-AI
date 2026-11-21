import { describe, expect, it, vi } from "vitest";

vi.mock("../app-language", () => ({ getAppLanguage: () => "fr" }));

import { approvalOutcome } from "../server-approval";

describe("approvalOutcome", () => {
	it("lets the build start once the card is approved", () => {
		expect(approvalOutcome({ approved: true }, "en")).toEqual({ success: true });
	});

	it("says how many approvals the card has, in the app's language", () => {
		const answer = { approved: false, approval: { count: 1, needed: 3 } };
		expect(approvalOutcome(answer, "en")).toEqual({
			success: false,
			error:
				"Your approval is recorded: 1 of 3. The build starts once the card has every approval it needs.",
		});
		expect(approvalOutcome(answer).error).toContain("1 sur 3");
	});

	it("reads nothing but whole counts from the server's answer", () => {
		for (const answer of [
			null,
			"approved",
			{ approved: "true" },
			{ approved: false, approval: "2 of 2" },
			{ approved: false, approval: { count: -1, needed: 1.5 } },
			{ approved: false, approval: { count: 1000, needed: "2" } },
		]) {
			const outcome = approvalOutcome(answer, "en");
			expect(outcome.success).toBe(false);
			expect(outcome.error).toContain("0 of 1");
		}
	});
});
