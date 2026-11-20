/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const { panel } = vi.hoisted(() => ({
	panel: { onSettingsChange: (_next: Record<string, unknown>): void => undefined },
}));
vi.mock("../settings/CleanProviderSection", () => ({
	CleanProviderSection: (props: { onSettingsChange: (next: Record<string, unknown>) => void; isOpen: boolean }) => {
		panel.onSettingsChange = props.onSettingsChange;
		return <div data-testid="accounts-panel" data-open={String(props.isOpen)} />;
	},
}));

import type { AppSettings } from "../../../shared/types/settings";
import { useSettingsStore } from "../../stores/settings-store";
import { PrivacyStep } from "./PrivacyStep";
import { ProvidersStep } from "./ProvidersStep";

const API = {
	saveSettings: vi.fn(),
	notifySentryStateChanged: vi.fn(),
};

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(globalThis.electronAPI, API);
	useSettingsStore.setState({ settings: {} as AppSettings });
});

describe("PrivacyStep", () => {
	it("reports errors by default and saves the choice before moving on", async () => {
		API.saveSettings.mockResolvedValue({ success: true });
		const onNext = vi.fn();
		render(<PrivacyStep onNext={onNext} onBack={vi.fn()} />);
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "true");

		await act(async () => fireEvent.click(screen.getByRole("button", { name: "common:buttons.continue" })));
		expect(API.saveSettings).toHaveBeenCalledWith({ sentryEnabled: true });
		expect(API.notifySentryStateChanged).toHaveBeenCalledWith(true);
		expect(useSettingsStore.getState().settings.sentryEnabled).toBe(true);
		expect(onNext).toHaveBeenCalledTimes(1);
	});

	it("keeps an earlier refusal and saves it when switched off", async () => {
		useSettingsStore.setState({ settings: { sentryEnabled: false } as AppSettings });
		API.saveSettings.mockResolvedValue({ success: true });
		render(<PrivacyStep onNext={vi.fn()} onBack={vi.fn()} />);
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "false");
		fireEvent.click(toggle);
		fireEvent.click(toggle);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "common:buttons.continue" })));
		expect(API.saveSettings).toHaveBeenCalledWith({ sentryEnabled: false });
	});

	it("says so when the choice could not be saved, and clears it on the next change", async () => {
		API.saveSettings.mockResolvedValueOnce({ success: false }).mockRejectedValueOnce(new Error("disk"));
		const onNext = vi.fn();
		render(<PrivacyStep onNext={onNext} onBack={vi.fn()} />);
		const save = screen.getByRole("button", { name: "common:buttons.continue" });

		await act(async () => fireEvent.click(save));
		expect(screen.getByRole("alert")).toHaveTextContent("onboarding:privacy.saveFailed");
		fireEvent.click(screen.getByRole("switch"));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		await act(async () => fireEvent.click(save));
		expect(screen.getByRole("alert")).toHaveTextContent("onboarding:privacy.saveFailed");
		expect(onNext).not.toHaveBeenCalled();
		expect(API.notifySentryStateChanged).not.toHaveBeenCalled();
	});

	it("shows that it is saving and goes back on demand", async () => {
		let finish: (value: unknown) => void = () => undefined;
		API.saveSettings.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const onBack = vi.fn();
		render(<PrivacyStep onNext={vi.fn()} onBack={onBack} />);
		fireEvent.click(screen.getByRole("button", { name: "common:buttons.continue" }));
		expect(screen.getByRole("button", { name: "common:buttons.saving" })).toBeDisabled();
		await act(async () => finish({ success: true }));
		expect(screen.getByRole("button", { name: "common:buttons.continue" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "common:buttons.back" }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});

describe("ProvidersStep", () => {
	it("embeds the accounts panel, keeps its changes and navigates", () => {
		const onNext = vi.fn();
		const onBack = vi.fn();
		render(<ProvidersStep onNext={onNext} onBack={onBack} />);
		expect(screen.getByTestId("accounts-panel")).toHaveAttribute("data-open", "true");
		act(() => panel.onSettingsChange({ globalOllamaApiUrl: "http://localhost:11434" }));
		expect(useSettingsStore.getState().settings).toMatchObject({ globalOllamaApiUrl: "http://localhost:11434" });

		fireEvent.click(screen.getByRole("button", { name: "common:buttons.back" }));
		fireEvent.click(screen.getByRole("button", { name: "onboarding:providers.continue" }));
		expect(onBack).toHaveBeenCalledTimes(1);
		expect(onNext).toHaveBeenCalledTimes(1);
	});
});
