/**
 * @vitest-environment jsdom
 */
/**
 * The plan of the account shown in the usage panel: its name when the
 * provider reports one, otherwise the billing mode, otherwise nothing.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsagePlanBadge } from "../UsagePlanBadge";

describe("UsagePlanBadge", () => {
	it("shows the plan name the provider reports", () => {
		render(<UsagePlanBadge plan={{ billing: "subscription", name: "ChatGPT Plus" }} />);
		const badge = screen.getByTestId("usage-plan-badge");
		expect(badge).toHaveTextContent("ChatGPT Plus");
		expect(badge).toHaveAttribute(
			"title",
			"Plan of this account, as the provider reports it.",
		);
	});

	it("names the billing mode when the plan has no name", () => {
		const { rerender } = render(<UsagePlanBadge plan={{ billing: "subscription" }} />);
		expect(screen.getByTestId("usage-plan-badge")).toHaveTextContent("Subscription");
		rerender(<UsagePlanBadge plan={{ billing: "api" }} />);
		const badge = screen.getByTestId("usage-plan-badge");
		expect(badge).toHaveTextContent("API key · pay as you go");
		expect(badge).toHaveAttribute(
			"title",
			"Billed per use through an API key: no plan windows apply.",
		);
	});

	it("shows nothing when the plan is unknown", () => {
		const { container } = render(<UsagePlanBadge />);
		expect(container).toBeEmptyDOMElement();
	});
});
