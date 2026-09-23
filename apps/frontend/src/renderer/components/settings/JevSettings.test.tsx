import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import en from "../../../shared/i18n/locales/en/settings.json";
import fr from "../../../shared/i18n/locales/fr/settings.json";
import { JevSettings } from "./JevSettings";
import { useSettingsStore } from "../../stores/settings-store";
import { useJevStore } from "../../stores/jev-store";
beforeEach(async () => {
	await i18n.changeLanguage("en");
	useSettingsStore.setState((s) => ({
		settings: { ...s.settings, jev: { enabled: false } },
	}));
	useJevStore.setState({ status: null });
	Object.assign(window.electronAPI, {
		getJevStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { configured: false, secureStorageAvailable: true },
		}),
		saveJevKey: vi.fn().mockResolvedValue({ success: true }),
		clearJevKey: vi.fn().mockResolvedValue({ success: true }),
		saveSettings: vi.fn().mockResolvedValue({ success: true }),
	});
});
afterEach(cleanup);
it("saves workflow overrides without persisting the typed key", async () => {
	render(<JevSettings />);
	const key = screen.getByLabelText("API key");
	fireEvent.change(key, { target: { value: "test-private" } });
	fireEvent.change(screen.getAllByRole("combobox")[0], {
		target: { value: "bypass" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
	await waitFor(() =>
		expect(window.electronAPI.saveSettings).toHaveBeenCalled(),
	);
	const saved = vi.mocked(window.electronAPI.saveSettings).mock.calls[0][0];
	expect(saved.jev?.workflows?.["feature-build"]).toBe("bypass");
	expect(JSON.stringify(saved)).not.toContain("test-private");
});
it("clears the password input after secure saving", async () => {
	render(<JevSettings />);
	await screen.findByText("No API key — workflows bypass JEV");
	const input = screen.getByLabelText("API key");
	fireEvent.change(input, { target: { value: "test-private" } });
	fireEvent.click(screen.getByRole("button", { name: "Save / replace key" }));
	await waitFor(() => expect(input).toHaveValue(""));
	expect(window.electronAPI.saveJevKey).toHaveBeenCalledWith("test-private");
});
it("ships matching real French and English keys", () => {
	function keys(value: object, prefix = ""): string[] {
		return Object.entries(value).flatMap(([key, item]) =>
			typeof item === "object"
				? keys(item, prefix + key + ".")
				: [prefix + key],
		);
	}
	expect(keys(fr.jev).sort()).toEqual(keys(en.jev).sort());
	for (const lang of ["en", "fr"])
		for (const key of keys(en.jev))
			expect(i18n.exists("jev." + key, { lng: lang, ns: "settings" })).toBe(
				true,
			);
});
