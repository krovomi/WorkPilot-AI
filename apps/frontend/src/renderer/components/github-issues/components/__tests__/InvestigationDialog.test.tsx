/**
 * After a failed investigation the dialog must say why and let the user out:
 * it used to keep a disabled "Creating…" spinner with no way to close it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InvestigationDialog } from "../InvestigationDialog";

describe("InvestigationDialog", () => {
	it("shows the error and a Close button in the error phase", () => {
		const onClose = vi.fn();
		render(
			<InvestigationDialog
				open
				onOpenChange={vi.fn()}
				selectedIssue={null}
				investigationStatus={{
					phase: "error",
					progress: 0,
					message: "gh: rate limited",
					error: "gh: rate limited",
				}}
				onStartInvestigation={vi.fn()}
				onClose={onClose}
			/>,
		);
		expect(screen.getByText("gh: rate limited")).toBeTruthy();
		expect(screen.queryByText(/creating/i)).toBeNull();
		// The footer's Close, not the dialog's corner X.
		const footerClose = screen
			.getAllByRole("button", { name: /close/i })
			.find((b) => b.textContent?.trim());
		expect(footerClose).toBeTruthy();
		fireEvent.click(footerClose as HTMLElement);
		expect(onClose).toHaveBeenCalled();
	});
});
