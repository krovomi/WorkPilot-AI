/**
 * Display settings: the switch of the Kanban column summary.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "../../../shared/constants";
import type { AppSettings } from "../../../shared/types";
import { DisplaySettings } from "./DisplaySettings";

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

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

describe("Closed PRs set aside", () => {
	it("is on by default and turns off", async () => {
		const { onSettingsChange, all } = renderWith({ kanbanAbandonClosedPrs: undefined });
		const toggle = screen.getByRole("switch", { name: "Set aside cards whose PR was closed" });
		expect(toggle).toBeChecked();
		await userEvent.click(toggle);
		expect(onSettingsChange).toHaveBeenCalledWith({ ...all, kanbanAbandonClosedPrs: false });
	});
});

describe("Auto-archive of finished cards", () => {
	it("is off by default and takes a delay", async () => {
		const user = userEvent.setup();
		const { onSettingsChange, all } = renderWith({ kanbanAutoArchiveDays: undefined });
		const select = screen.getByRole("combobox", { name: "Archive finished cards" });
		expect(select).toHaveTextContent("Never");
		await user.click(select);
		await user.click(await screen.findByRole("option", { name: "After 14 days" }));
		expect(onSettingsChange).toHaveBeenCalledWith({ ...all, kanbanAutoArchiveDays: 14 });
	});

	it("shows the saved delay", () => {
		renderWith({ kanbanAutoArchiveDays: 7 });
		expect(screen.getByRole("combobox", { name: "Archive finished cards" })).toHaveTextContent("After 7 days");
	});
});
