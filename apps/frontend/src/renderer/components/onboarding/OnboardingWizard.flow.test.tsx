/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

type Handlers = Record<string, (() => void) | undefined>;

/** A step reduced to its name and one button per handler the wizard gives it. */
function stub(name: string) {
	return (props: Handlers) => (
		<section aria-label={name}>
			{Object.entries(props)
				.filter(([, value]) => typeof value === "function")
				.map(([handler, value]) => (
					<button key={handler} type="button" onClick={value}>
						{`${name}:${handler}`}
					</button>
				))}
		</section>
	);
}

vi.mock("./WelcomeStep", () => ({ WelcomeStep: stub("welcome") }));
vi.mock("./AuthChoiceStep", () => ({ AuthChoiceStep: stub("auth-choice") }));
vi.mock("./OAuthStep", () => ({ OAuthStep: stub("oauth") }));
vi.mock("./ProvidersStep", () => ({ ProvidersStep: stub("providers") }));
vi.mock("./ClaudeCodeStep", () => ({ ClaudeCodeStep: stub("claude-code") }));
vi.mock("./DevToolsStep", () => ({ DevToolsStep: stub("devtools") }));
vi.mock("./PrivacyStep", () => ({ PrivacyStep: stub("privacy") }));
vi.mock("./CompletionStep", () => ({ CompletionStep: stub("completion") }));

import type { AppSettings } from "../../../shared/types/settings";
import { useSettingsStore } from "../../stores/settings-store";
import { OnboardingWizard } from "./OnboardingWizard";

const saveSettings = vi.fn();

const current = () => screen.getAllByRole("region")[0].getAttribute("aria-label");
const press = (label: string) => act(async () => fireEvent.click(screen.getByRole("button", { name: label })));
/** The labels of the progress bar, in order. */
const progress = () =>
	["steps.welcome", "steps.authChoice", "steps.auth", "steps.providers", "steps.cli", "steps.devtools", "steps.privacy", "steps.done"].filter(
		(label) => screen.queryByText(label),
	);

beforeEach(() => {
	vi.resetAllMocks();
	saveSettings.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, {
		saveSettings,
	});
	useSettingsStore.setState({ settings: { onboardingCompleted: false } as AppSettings });
});

describe("OnboardingWizard", () => {
	it("walks the Claude path, with the progress bar between the first and last screens", async () => {
		render(<OnboardingWizard open onOpenChange={vi.fn()} />);
		expect(current()).toBe("welcome");
		expect(progress()).toEqual([]);

		await press("welcome:onGetStarted");
		expect(current()).toBe("auth-choice");
		expect(progress()).toEqual([
			"steps.welcome",
			"steps.authChoice",
			"steps.auth",
			"steps.cli",
			"steps.devtools",
			"steps.privacy",
			"steps.done",
		]);

		await press("auth-choice:onNext");
		expect(current()).toBe("oauth");
		await press("oauth:onSkip");
		expect(current()).toBe("claude-code");
		await press("claude-code:onBack");
		expect(current()).toBe("oauth");
		await press("oauth:onNext");
		await press("claude-code:onSkip");
		expect(current()).toBe("devtools");
		await press("devtools:onNext");
		expect(current()).toBe("privacy");
		await press("privacy:onBack");
		expect(current()).toBe("devtools");
		await press("devtools:onBack");
		await press("claude-code:onNext");
		await press("devtools:onNext");
		await press("privacy:onNext");
		expect(current()).toBe("completion");
		expect(progress()).toEqual([]);
	});

	it("follows the API key path straight to the dev tools, and reopens the choice on the way back", async () => {
		render(<OnboardingWizard open onOpenChange={vi.fn()} />);
		await press("welcome:onGetStarted");
		await press("auth-choice:onAPIKeyPathComplete");
		expect(current()).toBe("devtools");
		expect(progress()).not.toContain("steps.auth");
		await press("devtools:onBack");
		expect(current()).toBe("auth-choice");
		// The choice is open again: the default path is back in the bar.
		expect(progress()).toContain("steps.auth");
		await press("auth-choice:onBack");
		expect(current()).toBe("welcome");
	});

	it("leads to the providers panel for another AI", async () => {
		render(<OnboardingWizard open onOpenChange={vi.fn()} />);
		await press("welcome:onGetStarted");
		await press("auth-choice:onOtherProvider");
		expect(current()).toBe("providers");
		expect(progress()).toContain("steps.providers");
		await press("providers:onNext");
		expect(current()).toBe("devtools");
		await press("devtools:onBack");
		await press("providers:onBack");
		expect(current()).toBe("auth-choice");
	});

	it("skips only the sign-in when the choice is skipped", async () => {
		render(<OnboardingWizard open onOpenChange={vi.fn()} />);
		await press("welcome:onGetStarted");
		await press("auth-choice:onSkip");
		expect(current()).toBe("claude-code");
	});

	it("sends the last screen without an AI back to the providers", async () => {
		render(<OnboardingWizard open onOpenChange={vi.fn()} />);
		await press("welcome:onGetStarted");
		await press("auth-choice:onAPIKeyPathComplete");
		await press("devtools:onNext");
		await press("privacy:onNext");
		await press("completion:onConnectProvider");
		expect(current()).toBe("providers");
	});

	it("saves the completion when the setup is finished, and starts over next time", async () => {
		const onOpenChange = vi.fn();
		render(<OnboardingWizard open onOpenChange={onOpenChange} />);
		await press("welcome:onGetStarted");
		await press("auth-choice:onAPIKeyPathComplete");
		await press("devtools:onNext");
		await press("privacy:onNext");
		await press("completion:onFinish");
		expect(saveSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
		expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(true);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(current()).toBe("welcome");
	});

	it("still closes and remembers it when the settings cannot be written", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const onOpenChange = vi.fn();
		saveSettings.mockResolvedValueOnce({ success: false, error: "read-only" }).mockRejectedValueOnce(new Error("disk"));
		render(<OnboardingWizard open onOpenChange={onOpenChange} />);
		await press("welcome:onSkip");
		await press("welcome:onSkip");
		expect(onOpenChange).toHaveBeenCalledTimes(2);
		expect(useSettingsStore.getState().settings.onboardingCompleted).toBe(true);
		expect(consoleError).toHaveBeenCalledTimes(2);
		consoleError.mockRestore();
	});

	it("finishes before opening the task creator or the settings", async () => {
		const onOpenChange = vi.fn();
		const onOpenTaskCreator = vi.fn();
		const onOpenSettings = vi.fn();
		const { unmount } = render(
			<OnboardingWizard
				open
				onOpenChange={onOpenChange}
				onOpenTaskCreator={onOpenTaskCreator}
				onOpenSettings={onOpenSettings}
			/>,
		);
		const toCompletion = async () => {
			await press("welcome:onGetStarted");
			await press("auth-choice:onAPIKeyPathComplete");
			await press("devtools:onNext");
			await press("privacy:onNext");
		};
		await toCompletion();
		await press("completion:onOpenTaskCreator");
		expect(onOpenTaskCreator).toHaveBeenCalledTimes(1);
		expect(saveSettings).toHaveBeenCalledTimes(1);
		await toCompletion();
		await press("completion:onOpenSettings");
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
		expect(saveSettings).toHaveBeenCalledTimes(2);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		unmount();

		// Without somewhere to go, these actions do nothing.
		render(<OnboardingWizard open onOpenChange={onOpenChange} />);
		await toCompletion();
		await press("completion:onOpenTaskCreator");
		await press("completion:onOpenSettings");
		expect(saveSettings).toHaveBeenCalledTimes(2);
		expect(current()).toBe("completion");
	});

	it("counts closing the window as skipping the setup", async () => {
		const onOpenChange = vi.fn();
		render(<OnboardingWizard open onOpenChange={onOpenChange} />);
		await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
		expect(saveSettings).toHaveBeenCalledWith({ onboardingCompleted: true });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
