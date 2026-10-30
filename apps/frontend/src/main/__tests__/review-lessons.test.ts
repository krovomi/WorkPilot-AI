/**
 * @vitest-environment node
 *
 * The feedback given with a rejected plan goes to the backend as a rule
 * candidate (IA1), and the review never waits on it nor fails because of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("../ipc-handlers/_backend-fetch", () => ({ backendFetch }));

import { recordPlanFeedback } from "../review-lessons";

describe("recordPlanFeedback", () => {
	beforeEach(() => {
		backendFetch.mockReset();
	});

	it("sends the trimmed feedback with the project and the spec", async () => {
		backendFetch.mockResolvedValue({ success: true, recorded: true });

		await expect(
			recordPlanFeedback("/home/dev/shop", "004-orders", "  Keep EF out of Domain. "),
		).resolves.toBe(true);

		const [route, init] = backendFetch.mock.calls[0];
		expect(route).toBe("/api/brain/review-lessons/plan-feedback");
		expect(JSON.parse(init.body)).toEqual({
			project_dir: "/home/dev/shop",
			spec_id: "004-orders",
			feedback: "Keep EF out of Domain.",
		});
	});

	it("sends nothing without feedback", async () => {
		await expect(recordPlanFeedback("/p", "004", undefined)).resolves.toBe(false);
		await expect(recordPlanFeedback("/p", "004", "   ")).resolves.toBe(false);
		expect(backendFetch).not.toHaveBeenCalled();
	});

	it("never throws when the backend is down", async () => {
		backendFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(recordPlanFeedback("/p", "004", "Keep it small.")).resolves.toBe(
			false,
		);
	});
});
