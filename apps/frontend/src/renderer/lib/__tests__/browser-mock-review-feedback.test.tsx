/**
 * In the browser preview the review feedback (#361) answers like an empty
 * dataset, in the shape the main process uses.
 */
import { describe, expect, it, vi } from "vitest";

describe("browser mock: review feedback", () => {
	it("records nothing and reads nothing", async () => {
		// The test set-up installs its own bridge; the preview has none.
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.resetModules();
		const { initBrowserMock } = await import("../browser-mock");
		initBrowserMock();
		const github = window.electronAPI.github;
		await expect(
			github.setReviewFindingFeedback("p", 1, { findingId: "f", verdict: "accepted" }),
		).resolves.toEqual({ success: true, feedback: {} });
		await expect(github.getReviewFindingFeedback("p", 1)).resolves.toEqual({
			success: true,
			feedback: {},
		});
		await expect(github.getReviewFeedbackStats("p")).resolves.toEqual({
			success: true,
			stats: { threshold: 3, categories: [], rules: [] },
		});
		await expect(
			github.resetReviewFeedbackRule("p", "0123456789abcdef"),
		).resolves.toEqual({ success: false, error: "not_found" });
		await expect(
			github.decideHeldReviewFeedback("p", 1, "f", true),
		).resolves.toEqual({ success: false, error: "not_found" });
		await expect(github.writeReviewConventions("p")).resolves.toEqual({
			success: false,
			error: "write_failed",
		});
	});
});
