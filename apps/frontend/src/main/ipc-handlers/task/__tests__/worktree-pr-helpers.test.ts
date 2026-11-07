/**
 * @vitest-environment node
 *
 * The PR script's answer, and the one flag that lets a person create a PR
 * the cross review disagrees with (IA2).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../updater/path-resolver", () => ({
	getEffectiveSourcePath: () => undefined,
}));

import { buildCreatePRArgs, parsePRJsonOutput } from "../worktree-pr-helpers";

const held = {
	success: false,
	error:
		"Cross review by openai / gpt-5.5 disagrees with this change (1 blocking problem(s)):\n- src/Orders.cs:42: DELETE /orders/{id} is missing.",
	cross_review_blocked: true,
};

describe("parsePRJsonOutput", () => {
	it("reads the hold, even when the message quotes code with braces", () => {
		const stdout = `Pushing branch...\n{not json}\n${JSON.stringify(held)}\n`;

		expect(parsePRJsonOutput(stdout)).toEqual({
			success: false,
			prUrl: undefined,
			alreadyExists: undefined,
			error: held.error,
			crossReviewBlocked: true,
		});
	});

	it("still reads an answer that is not on a line of its own", () => {
		const parsed = parsePRJsonOutput(
			'done {"success": true, "pr_url": "https://github.com/a/b/pull/1"}',
		);
		expect(parsed?.prUrl).toBe("https://github.com/a/b/pull/1");
		expect(parsed?.crossReviewBlocked).toBeUndefined();
	});
});

describe("buildCreatePRArgs", () => {
	const build = (options: Record<string, unknown>) =>
		buildCreatePRArgs("run.py", "004-orders", "/p", options, undefined).args;

	it("passes the override only when the person chose it", () => {
		expect(build({ allowCrossReviewDisagreement: true })).toContain(
			"--pr-ignore-cross-review",
		);
		for (const value of [undefined, false, "true", 1]) {
			expect(build({ allowCrossReviewDisagreement: value })).not.toContain(
				"--pr-ignore-cross-review",
			);
		}
	});
});
