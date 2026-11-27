/** The card's approval tier badge: the tier, then what happened to the green PR. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskApprovalSummary } from "@shared/types";
import { ApprovalTierBadge, shownApprovalTier } from "../ApprovalTierBadge";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, string>) =>
			options ? `${key}|${Object.values(options).join("|")}` : key,
	}),
}));

const card = (approval?: TaskApprovalSummary) => ({ id: "t", approval }) as unknown as Task;

describe("ApprovalTierBadge", () => {
	it.each([
		[{ tier: "N0", mode: "enforce", action: "merge", merged: true }, "merged"],
		[{ tier: "N2", mode: "enforce", action: "human", merged: false }, "waiting"],
		[{ tier: "N0", mode: "enforce", action: "merge", merged: false }, "mergeFailed"],
		[{ tier: "N3", mode: "observe", action: "human", merged: false }, "observed"],
	])("shows %o as %s", (approval, outcome) => {
		render(<ApprovalTierBadge task={card(approval)} />);
		const badge = screen.getByTestId("approval-tier-badge");
		expect(badge.textContent).toContain(approval.tier);
		expect(badge.textContent).toContain(`approvalTier.outcome.${outcome}`);
	});

	it("names the strictest reasons in its title", () => {
		const approval = {
			tier: "N3",
			mode: "observe",
			reasons: [
				{ code: "sensitive_paths", tier: "N3" },
				{ code: "feature", tier: "N2" },
			],
		};
		render(<ApprovalTierBadge task={card(approval)} />);
		expect(screen.getByTestId("approval-tier-badge").getAttribute("title")).toContain(
			"approvalTier.reasons.sensitive_paths",
		);
	});

	it("shows nothing without a known tier", () => {
		const { container } = render(<ApprovalTierBadge task={card(undefined)} />);
		expect(container).toBeEmptyDOMElement();
		render(<ApprovalTierBadge task={card({ error: "git failed" })} />);
		expect(screen.queryByTestId("approval-tier-badge")).toBeNull();
		expect(shownApprovalTier({ tier: "N7" })).toBeNull();
		expect(shownApprovalTier({ tier: "N1" })).toBe("N1");
	});
});
