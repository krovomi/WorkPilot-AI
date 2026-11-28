/** Settings, Code mode: off by default, and each choice saves `codeMode`. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { CodeModeSettings } from "../CodeModeSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const base = { theme: "system" } as unknown as AppSettings;

describe("CodeModeSettings", () => {
	it("shows off when nothing is saved", () => {
		render(<CodeModeSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("code-mode-off")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("code-mode-auto")).toHaveAttribute("aria-pressed", "false");
	});

	it("shows an unknown saved value as off", () => {
		const settings = { ...base, codeMode: "always" } as unknown as AppSettings;
		render(<CodeModeSettings settings={settings} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("code-mode-off")).toHaveAttribute("aria-pressed", "true");
	});

	it("saves each choice and keeps the other settings", () => {
		const change = vi.fn();
		render(<CodeModeSettings settings={base} onSettingsChange={change} />);
		fireEvent.click(screen.getByTestId("code-mode-auto"));
		expect(change.mock.calls.at(-1)?.[0]).toMatchObject({ theme: "system", codeMode: "auto" });
		fireEvent.click(screen.getByText("sections.codeMode.mode.on.label"));
		expect(change.mock.calls.at(-1)?.[0].codeMode).toBe("on");
	});
});
