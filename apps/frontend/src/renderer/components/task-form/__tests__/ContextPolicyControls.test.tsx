/**
 * @vitest-environment jsdom
 */

/**
 * The context-window controls in English, with the capability matrix the
 * backend serves (through `electronAPI.localBackendRequest`): the card's
 * summary when the policy is off, the dense controls of the live gauge's
 * popover, and the provider hint.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	ContextPolicyControls,
	ContextPolicyFields,
	ContextProviderHint,
} from "../ContextPolicyFields";

const localBackendRequest = vi.fn();
const originalApi = window.electronAPI;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	localBackendRequest.mockReset().mockResolvedValue({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify({
			providers: {
				claude: { hasAdapter: true, contextCompact: "native" },
				"acme-llm": { hasAdapter: true, contextCompact: "emulated" },
			},
		}),
	});
	(window as unknown as { electronAPI: unknown }).electronAPI = { localBackendRequest };
});
afterEach(cleanup);
afterAll(() => {
	(window as unknown as { electronAPI: unknown }).electronAPI = originalApi;
});

describe("ContextPolicyFields in English", () => {
	it("summarises an active policy and an off one", () => {
		render(
			<ContextPolicyFields
				value={{ mode: "compact", thresholdPct: 70, prepareHandoff: false }}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByText("Compact · threshold 70%")).toBeInTheDocument();
		cleanup();
		render(
			<ContextPolicyFields
				value={{ mode: "off", thresholdPct: 70, prepareHandoff: false }}
				onChange={vi.fn()}
				defaultOpen
			/>,
		);
		expect(screen.getByText("Off — manual only")).toBeInTheDocument();
		expect(screen.getByRole("slider", { name: "Threshold" })).toBeDisabled();
		expect(screen.getByRole("switch", { name: "Prepare the handoff in parallel" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Show context settings" }));
		expect(screen.queryByRole("slider")).not.toBeInTheDocument();
	});
});

describe("ContextPolicyControls", () => {
	it("leaves the hints out of the dense popover", () => {
		render(
			<ContextPolicyControls
				value={{ mode: "auto", thresholdPct: 50, prepareHandoff: true }}
				onChange={vi.fn()}
				dense
			/>,
		);
		expect(screen.getByRole("radiogroup", { name: "When the threshold is reached" })).toBeInTheDocument();
		expect(screen.getByRole("slider", { name: "Threshold" })).toHaveAttribute("aria-valuetext", "50%");
		expect(screen.getByRole("slider", { name: "Threshold" })).toHaveAttribute("id", "context-threshold");
		expect(screen.queryByText(/Writes the handoff summary in the background/)).not.toBeInTheDocument();
	});
});

describe("ContextProviderHint", () => {
	it("names the provider and how its context is compacted", async () => {
		const { rerender } = render(<ContextProviderHint provider="anthropic" />);
		expect(await screen.findByText("Anthropic (Claude): native compaction")).toBeInTheDocument();
		rerender(<ContextProviderHint provider="acme-llm" className="mt-2" />);
		expect(screen.getByText("acme-llm: compaction emulated by summary")).toHaveClass("mt-2");
	});

	it("says nothing without a provider", async () => {
		const { container } = render(<ContextProviderHint provider={null} />);
		await waitFor(() => expect(localBackendRequest).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
