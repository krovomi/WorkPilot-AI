/** A task's own code mode per phase: Settings' by default, a phase at a time. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	normalizePhaseCodeMode,
	phaseCodeModeToSave,
} from "../../../../shared/utils/code-mode";
import { PhaseCodeModePicker } from "../PhaseCodeModePicker";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PhaseCodeModePicker", () => {
	it("shows Settings' mode when the phase has none of its own", () => {
		render(
			<PhaseCodeModePicker phase="coding" value={{ qa: "on" }} onChange={vi.fn()} idPrefix="t" />,
		);
		expect(screen.getByTestId("t-code-mode-default")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("t-code-mode-on")).toHaveAttribute("aria-pressed", "false");
	});

	it("sets one phase and leaves the others, then gives it back to Settings", () => {
		const change = vi.fn();
		const { rerender } = render(
			<PhaseCodeModePicker phase="coding" value={{ qa: "off" }} onChange={change} idPrefix="t" />,
		);
		fireEvent.click(screen.getByTestId("t-code-mode-auto"));
		expect(change).toHaveBeenLastCalledWith({ qa: "off", coding: "auto" });

		rerender(
			<PhaseCodeModePicker
				phase="coding"
				value={{ qa: "off", coding: "auto" }}
				onChange={change}
				idPrefix="t"
			/>,
		);
		expect(screen.getByTestId("t-code-mode-auto")).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByTestId("t-code-mode-default"));
		expect(change).toHaveBeenLastCalledWith({ qa: "off" });
	});
});

describe("phase code mode values", () => {
	it("keeps only known phases with known modes", () => {
		expect(
			normalizePhaseCodeMode({ coding: "on", qa: "always", review: "on", spec: 1 }),
		).toEqual({ coding: "on" });
		expect(normalizePhaseCodeMode(null)).toEqual({});
		expect(normalizePhaseCodeMode("on")).toEqual({});
	});

	it("saves nothing when no phase has its own mode", () => {
		expect(phaseCodeModeToSave({})).toBeUndefined();
		expect(phaseCodeModeToSave({ planning: "off" })).toEqual({ planning: "off" });
	});
});
