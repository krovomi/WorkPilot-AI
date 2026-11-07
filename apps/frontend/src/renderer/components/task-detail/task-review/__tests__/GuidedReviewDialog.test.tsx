/** @vitest-environment jsdom */
/**
 * The guided review: groups in the plan's order with the planner's
 * explanation, files outside the plan flagged, QA issues on their file, and
 * "viewed" kept for the task until the patch changes.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { ReviewGroups } from "../../../../../shared/types/review-groups";
import { GuidedReviewDialog } from "../GuidedReviewDialog";

function groups(patch = "@@ -1 +1 @@\n-a\n+b"): ReviewGroups {
	return {
		approximate: false,
		outOfPlan: ["util.ts"],
		unanchoredQa: [],
		groups: [
			{
				key: "subtask:s1:c1",
				kind: "subtask",
				title: "Add the orders route",
				description: "GET /orders returns the user's orders",
				subtaskId: "s1",
				from: "base",
				to: "c1",
				files: [
					{
						path: "api.ts",
						status: "modified",
						additions: 1,
						deletions: 1,
						patch,
						hash: patch.length.toString(16),
						outOfPlan: false,
						touchedLater: ["commit:c2"],
						moved: [],
						qaNotes: [{ file: "api.ts", line: 4, title: "No auth check", severity: "major" }],
					},
					{
						path: "util.ts",
						status: "added",
						additions: 2,
						deletions: 0,
						patch: "@@ -0,0 +1 @@\n+x",
						hash: "u1",
						outOfPlan: true,
						touchedLater: [],
						moved: [{ direction: "in", otherPath: "old.ts", lines: 5, preview: "function total() {" }],
						qaNotes: [],
					},
				],
			},
			{ key: "commit:c2", kind: "commit", title: "fix lint", description: "", from: "c1", to: "c2", files: [] },
		],
	};
}

const api = { getReviewGroups: vi.fn() };

beforeEach(() => {
	window.localStorage.clear();
	api.getReviewGroups.mockResolvedValue({ success: true, data: groups() });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("GuidedReviewDialog", () => {
	it("shows the subtask with its explanation, out-of-plan files, moves and QA issues", async () => {
		render(<GuidedReviewDialog open taskId="task-1" onOpenChange={vi.fn()} onShowFinalDiff={vi.fn()} />);
		expect(await screen.findByText("GET /orders returns the user's orders")).toBeInTheDocument();
		expect(api.getReviewGroups).toHaveBeenCalledWith("task-1");
		expect(screen.getByText("Outside the plan")).toBeInTheDocument();
		expect(screen.getByText("5 lines moved here from old.ts")).toBeInTheDocument();
		expect(screen.getByText("No auth check")).toBeInTheDocument();
		expect(screen.getByText(/Changed again later by: fix lint/)).toBeInTheDocument();
	});

	it("keeps a file viewed for the task until its patch changes", async () => {
		const { unmount } = render(
			<GuidedReviewDialog open taskId="task-1" onOpenChange={vi.fn()} onShowFinalDiff={vi.fn()} />,
		);
		await screen.findByText("0/2 viewed");
		fireEvent.click(screen.getAllByRole("checkbox")[0]);
		expect(await screen.findByText("1/2 viewed")).toBeInTheDocument();
		unmount();

		render(<GuidedReviewDialog open taskId="task-1" onOpenChange={vi.fn()} onShowFinalDiff={vi.fn()} />);
		expect(await screen.findByText("1/2 viewed")).toBeInTheDocument();
		cleanup();

		// A QA fix changed the patch: the file is to be read again.
		api.getReviewGroups.mockResolvedValue({ success: true, data: groups("@@ -1 +1 @@\n-a\n+b, fixed") });
		render(<GuidedReviewDialog open taskId="task-1" onOpenChange={vi.fn()} onShowFinalDiff={vi.fn()} />);
		expect(await screen.findByText("0/2 viewed")).toBeInTheDocument();
	});

	it("sends a server card to the final diff", async () => {
		api.getReviewGroups.mockResolvedValue({ success: false, error: "local_only" });
		const onShowFinalDiff = vi.fn();
		render(<GuidedReviewDialog open taskId="task-1" onOpenChange={vi.fn()} onShowFinalDiff={onShowFinalDiff} />);
		expect(await screen.findByText(/available for local tasks/)).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: "Final diff, all files" })[0]);
		await waitFor(() => expect(onShowFinalDiff).toHaveBeenCalled());
	});
});
