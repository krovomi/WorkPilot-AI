/**
 * @vitest-environment jsdom
 */
/**
 * The Copilot part of the usage popover: the context window of the last turn,
 * then the premium quota, the organisation metrics or the reason none is shown.
 */
import type { UsageSnapshot } from "@shared/types";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotUsageContent } from "../CopilotUsageContent";

const state = vi.hoisted(() => ({
	context: null as null | {
		percentUsed: number;
		model: string;
		contextTokens: number;
		contextWindow: number;
	},
}));

vi.mock("../../../hooks/useContextUsage", () => ({
	useContextUsage: () => state.context,
}));

function usage(over: Record<string, unknown> = {}): UsageSnapshot {
	return {
		profileId: "p",
		profileName: "p",
		sessionPercent: 0,
		weeklyPercent: 0,
		fetchedAt: new Date(),
		providerName: "copilot",
		...over,
	} as unknown as UsageSnapshot;
}

beforeEach(() => {
	state.context = null;
});

describe("CopilotUsageContent", () => {
	it("shows the context window of the last turn", () => {
		state.context = { percentUsed: 92.25, model: "gpt-5", contextTokens: 118000, contextWindow: 128000 };
		const { container } = render(<CopilotUsageContent usage={usage()} />);
		expect(screen.getByText("Context window")).toBeInTheDocument();
		expect(screen.getByText("gpt-5")).toBeInTheDocument();
		expect(screen.getByText("92.3%")).toBeInTheDocument();
		expect(screen.getByText(/118,000/)).toHaveTextContent("118,000 / 128,000");
		expect(container.querySelector(".bg-destructive")).not.toBeNull();
	});

	it("colours the context bar by how full it is", () => {
		for (const [percent, colour] of [
			[80, ".bg-orange-500"],
			[20, ".bg-blue-500"],
		] as const) {
			state.context = { percentUsed: percent, model: "m", contextTokens: 1, contextWindow: 2 };
			const view = render(<CopilotUsageContent usage={usage()} />);
			expect(view.container.querySelector(colour)).not.toBeNull();
			view.unmount();
		}
	});

	it("explains missing organisation permissions, with the backend's message when it has one", () => {
		const first = render(
			<CopilotUsageContent usage={usage({ error: "INSUFFICIENT_PERMISSIONS" })} />,
		);
		expect(screen.getByText("Insufficient permissions")).toBeInTheDocument();
		expect(screen.getByText("Insufficient permissions to access Copilot metrics.")).toBeInTheDocument();
		expect(screen.getByText("gh auth refresh -h github.com -s admin:org")).toBeInTheDocument();
		first.unmount();
		render(
			<CopilotUsageContent
				usage={usage({ error: "INSUFFICIENT_PERMISSIONS", errorMessage: "Needs admin:org" })}
			/>,
		);
		expect(screen.getByText("Needs admin:org")).toBeInTheDocument();
	});

	it("says the backend is not running", () => {
		render(<CopilotUsageContent usage={usage({ error: "BACKEND_UNAVAILABLE" })} />);
		expect(screen.getByText("Backend unavailable")).toBeInTheDocument();
	});

	it("shows the premium quota with its plan, organisation and reset date", () => {
		const { container } = render(
			<CopilotUsageContent
				usage={usage({
					copilotUsageDetails: {
						scope: "personal-quotas",
						premiumRequestsUsed: 240,
						premiumRequestsEntitlement: 300,
						premiumRequestsRemaining: 60,
						premiumRequestsPercentUsed: 80,
						plan: "Pro",
						organization: "acme",
						quotaResetDate: "2026-12-01T00:00:00Z",
					},
				})}
			/>,
		);
		expect(screen.getByText("Copilot Premium Requests")).toBeInTheDocument();
		expect(screen.getByText("Pro plan — current billing cycle usage.")).toBeInTheDocument();
		expect(screen.getByText("80.0%")).toBeInTheDocument();
		expect(screen.getByText("240")).toBeInTheDocument();
		expect(screen.getByText("300")).toBeInTheDocument();
		expect(screen.getByText("60")).toBeInTheDocument();
		expect(screen.getByText("acme")).toBeInTheDocument();
		expect(screen.getByText(/^Resets on /)).toBeInTheDocument();
		expect(container.querySelector(".bg-orange-500")).not.toBeNull();
	});

	it("shows an unlimited quota, zero defaults, and a reset date it cannot read", () => {
		const first = render(
			<CopilotUsageContent
				usage={usage({
					copilotUsageDetails: { scope: "personal-quotas", premiumRequestsUnlimited: true },
				})}
			/>,
		);
		expect(screen.getByText("Unlimited")).toBeInTheDocument();
		expect(screen.getByText("Copilot usage for the current billing cycle.")).toBeInTheDocument();
		first.unmount();

		const second = render(
			<CopilotUsageContent
				usage={usage({
					copilotUsageDetails: {
						scope: "personal-quotas",
						premiumRequestsPercentUsed: 95,
						quotaResetDate: "next month",
					},
				})}
			/>,
		);
		expect(screen.getByText("Resets on next month")).toBeInTheDocument();
		expect(second.container.querySelector(".bg-destructive")).not.toBeNull();
		second.unmount();

		const third = render(
			<CopilotUsageContent usage={usage({ copilotUsageDetails: { scope: "personal-quotas" } })} />,
		);
		expect(screen.getByText("0.0%")).toBeInTheDocument();
		expect(third.container.querySelector(".bg-blue-500")).not.toBeNull();
		expect(screen.queryByText(/Resets on/)).toBeNull();
	});

	it("shows the organisation metrics it has", () => {
		render(
			<CopilotUsageContent
				usage={usage({
					copilotUsageDetails: {
						scope: "aggregated-metrics",
						suggestionsCount: 120,
						acceptancesCount: 30,
						acceptanceRate: 25,
						totalTokens: 4000,
					},
				})}
			/>,
		);
		expect(screen.getByText("GitHub Copilot Metrics")).toBeInTheDocument();
		expect(screen.getByText("120")).toBeInTheDocument();
		expect(screen.getByText("30")).toBeInTheDocument();
		expect(screen.getByText("25.0%")).toBeInTheDocument();
		expect(screen.getByText("4000")).toBeInTheDocument();
	});

	it("leaves out metrics that are missing or zero", () => {
		const first = render(
			<CopilotUsageContent usage={usage({ copilotUsageDetails: { scope: "aggregated-metrics", totalTokens: 0 } })} />,
		);
		expect(screen.queryByText(/Tokens used/)).toBeNull();
		expect(screen.queryByText(/Suggestions/)).toBeNull();
		first.unmount();
		render(<CopilotUsageContent usage={usage()} />);
		expect(screen.getByText("GitHub Copilot usage data for the last 28 days.")).toBeInTheDocument();
	});
});
