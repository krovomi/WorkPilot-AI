/**
 * Display settings: the switch of the Kanban column summary.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../../shared/constants";
import type { AppSettings } from "../../../shared/types";
import { DisplaySettings } from "./DisplaySettings";

function renderWith(settings: Partial<AppSettings> = {}) {
	const onSettingsChange = vi.fn();
	const all = { ...DEFAULT_APP_SETTINGS, ...settings } as AppSettings;
	render(<DisplaySettings settings={all} onSettingsChange={onSettingsChange} />);
	return { onSettingsChange, all };
}

describe("Kanban column summary", () => {
	it("is on by default and turns off", async () => {
		const { onSettingsChange, all } = renderWith({ kanbanColumnSummary: undefined });
		const toggle = screen.getByRole("switch", { name: "Column summary" });
		expect(toggle).toBeChecked();
		await userEvent.click(toggle);
		expect(onSettingsChange).toHaveBeenCalledWith({ ...all, kanbanColumnSummary: false });
	});

	it("turns back on", async () => {
		const { onSettingsChange, all } = renderWith({ kanbanColumnSummary: false });
		const toggle = screen.getByRole("switch", { name: "Column summary" });
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		expect(onSettingsChange).toHaveBeenCalledWith({ ...all, kanbanColumnSummary: true });
	});
});
