/**
 * @vitest-environment jsdom
 */

/**
 * ContextPolicyFields — the per-task context-window card of the task forms.
 *
 * Pinned: collapsed it shows a summary; open, the segmented mode control, the
 * threshold slider (snapped to 30..90 step 5) and the handoff switch each emit
 * a complete policy; the provider hint comes from the served capability
 * matrix and disappears when the matrix does not know the provider.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { DEFAULT_CONTEXT_POLICY } from "../../../../shared/utils/context-policy";

const contextCompact = vi.fn();

vi.mock("../../../hooks/useAgenticCapabilities", () => ({
	useAgenticCapabilities: () => ({ contextCompact }),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

import { ContextPolicyFields } from "../ContextPolicyFields";

beforeEach(() => {
	contextCompact.mockReset();
});

function renderOpen(onChange = vi.fn(), provider: string | null = "claude") {
	render(
		<ContextPolicyFields
			value={{ ...DEFAULT_CONTEXT_POLICY }}
			onChange={onChange}
			provider={provider}
			idPrefix="test"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "tasks:contextManagement.toggle" }));
	return onChange;
}

describe("ContextPolicyFields", () => {
	it("is collapsed by default and shows the summary", () => {
		render(
			<ContextPolicyFields value={{ ...DEFAULT_CONTEXT_POLICY }} onChange={vi.fn()} />,
		);
		expect(screen.getByText("tasks:contextManagement.title")).toBeInTheDocument();
		expect(screen.getByText(/tasks:contextManagement\.summary:/)).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
	});

	it("emits the chosen mode", () => {
		const onChange = renderOpen();
		fireEvent.click(screen.getByRole("radio", { name: "tasks:contextManagement.modes.clear" }));
		expect(onChange).toHaveBeenCalledWith({
			mode: "clear",
			thresholdPct: 50,
			prepareHandoff: true,
		});
	});

	it("snaps the threshold to the grid", () => {
		const onChange = renderOpen();
		fireEvent.change(screen.getByLabelText("tasks:contextManagement.threshold.label"), {
			target: { value: "72" },
		});
		expect(onChange).toHaveBeenCalledWith({
			mode: "auto",
			thresholdPct: 70,
			prepareHandoff: true,
		});
	});

	it("toggles the parallel handoff", () => {
		const onChange = renderOpen();
		fireEvent.click(screen.getByLabelText("tasks:contextManagement.prepareHandoff.label"));
		expect(onChange).toHaveBeenCalledWith({
			mode: "auto",
			thresholdPct: 50,
			prepareHandoff: false,
		});
	});

	it("hints native compaction when the matrix says so", () => {
		contextCompact.mockReturnValue("native");
		renderOpen();
		expect(screen.getByTestId("context-provider-hint").textContent).toContain(
			"tasks:contextManagement.provider.native",
		);
	});

	it("hides the hint when the provider is unknown to the matrix", () => {
		contextCompact.mockReturnValue(null);
		renderOpen();
		expect(screen.queryByTestId("context-provider-hint")).not.toBeInTheDocument();
	});
});
