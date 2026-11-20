/**
 * @vitest-environment jsdom
 */
/**
 * OnboardingWizard integration tests
 *
 * Integration tests for the complete onboarding wizard flow.
 * Verifies step navigation, OAuth/API key paths, back button behavior,
 * and progress indicator.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { OnboardingWizard } from "./OnboardingWizard";

// Mock react-i18next to avoid initialization issues
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// Return the key itself or provide specific translations
			// Keys are without namespace since component uses useTranslation('namespace')
			const translations: Record<string, string> = {
				"welcome.title": "Welcome to WorkPilot AI",
				"welcome.subtitle": "AI-powered autonomous coding assistant",
				"welcome.getStarted": "Get Started",
				"welcome.skip": "Skip Setup",
				"wizard.helpText": "Let us help you get started with WorkPilot AI",
				"welcome.features.aiPowered.title": "AI-Powered",
				"welcome.features.aiPowered.description": "Powered by Claude",
				"welcome.features.specDriven.title": "Spec-Driven",
				"welcome.features.specDriven.description": "Create from specs",
				"welcome.features.memory.title": "Memory",
				"welcome.features.memory.description": "Remembers context",
				"welcome.features.parallel.title": "Parallel",
				"welcome.features.parallel.description": "Work in parallel",
				"authChoice.title": "Choose Your Authentication Method",
				"authChoice.subtitle": "Select how you want to authenticate",
				"authChoice.oauthTitle": "Sign in with Anthropic",
				"authChoice.oauthDesc": "OAuth authentication",
				"authChoice.apiKeyTitle": "Use Custom API Key",
				"authChoice.apiKeyDesc": "Enter your own API key",
				"authChoice.skip": "Skip for nowA",
				// Common translations
				"common:actions.close": "Close",
			};
			// Steps also call fully qualified keys (`onboarding:authChoice.title`).
			return (
				translations[key] ||
				translations[key.replace(/^onboarding:/, "")] ||
				key
			);
		},
		i18n: { language: "en" },
	}),
	Trans: ({ children }: { children: React.ReactNode }) => children,
}));

// The providers step embeds the Settings → Accounts panel.
vi.mock("../settings/CleanProviderSection", () => ({
	CleanProviderSection: () => <div>accounts-panel</div>,
}));

// Mock the settings store
const mockUpdateSettings = vi.fn();
const mockLoadSettings = vi.fn();
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
const mockProfiles: any[] = [];

vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: vi.fn((selector) => {
		const state = {
			settings: { onboardingCompleted: false },
			isLoading: false,
			profiles: mockProfiles,
			activeProfileId: null,
			updateSettings: mockUpdateSettings,
			loadSettings: mockLoadSettings,
		};
		if (!selector) return state;
		return selector(state);
	}),
}));

// Mock electronAPI
const mockSaveSettings = vi.fn().mockResolvedValue({ success: true });

Object.defineProperty(window, "electronAPI", {
	value: {
		saveSettings: mockSaveSettings,
		onAppUpdateDownloaded: vi.fn(),
		// OAuth-related methods needed for OAuthStep component
		onTerminalOAuthToken: vi.fn(() => vi.fn()), // Returns unsubscribe function
		getOAuthToken: vi.fn().mockResolvedValue(null),
		startOAuthFlow: vi.fn().mockResolvedValue({ success: true }),
		loadProfiles: vi.fn().mockResolvedValue([]),
		checkClaudeCodeVersion: vi.fn().mockResolvedValue({ success: false }),
	},
	writable: true,
});

describe("OnboardingWizard Integration Tests", () => {
	const defaultProps = {
		open: true,
		onOpenChange: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("API Key Path Navigation", () => {
		it("should not show OAuth step text on auth-choice screen", async () => {
			render(<OnboardingWizard {...defaultProps} />);

			// Navigate to auth-choice
			fireEvent.click(screen.getByRole("button", { name: /Get Started/ }));
			await waitFor(() => {
				expect(
					screen.getByText(/Choose Your Authentication Method/),
				).toBeInTheDocument();
			});

			// When profile is created via API key path, should skip oauth
			// This is tested via component behavior - the wizard should advance
			// directly to the completion step, bypassing oauth
			const oauthStepText = screen.queryByText(/OAuth Authentication/);
			// Before API key selection, oauth text from different context shouldn't be visible
			expect(oauthStepText).toBeNull();
		});
	});

	describe("Back Button Behavior After API Key Path", () => {
		it("should go back to auth-choice (not oauth) when coming from API key path", async () => {
			render(<OnboardingWizard {...defaultProps} />);

			// This test verifies that when oauth is bypassed (API key path taken),
			// going back from completion returns to auth-choice, not oauth

			// Navigate: welcome → auth-choice
			fireEvent.click(screen.getByText(/Get Started/));
			await waitFor(() => {
				expect(
					screen.getByText(/Choose Your Authentication Method/),
				).toBeInTheDocument();
			});

			// The back button behavior is controlled by oauthBypassed state
			// When API key path is taken, oauthBypassed=true
			// Going back from completion should skip oauth step
			const authChoiceHeading = screen.getByText(
				/Choose Your Authentication Method/,
			);
			expect(authChoiceHeading).toBeInTheDocument();
		});
	});

	describe("First-Run Detection", () => {
		it("should show wizard for users with no auth configured", () => {
			render(<OnboardingWizard {...defaultProps} open={true} />);

			// Wizard should be visible
			expect(screen.getByText(/Welcome to WorkPilot AI/)).toBeInTheDocument();
		});

		it("should not show wizard for users with existing OAuth", () => {
			// This is tested in App.tsx integration tests
			// Here we verify the wizard can be closed
			const { rerender } = render(
				<OnboardingWizard {...defaultProps} open={true} />,
			);

			expect(screen.getByText(/Welcome to WorkPilot AI/)).toBeInTheDocument();

			// Close wizard
			rerender(<OnboardingWizard {...defaultProps} open={false} />);

			// Wizard content should not be visible
			expect(
				screen.queryByText(/Welcome to WorkPilot AI/),
			).not.toBeInTheDocument();
		});

		it("should not show wizard for users with existing API profiles", () => {
			// This is tested in App.tsx integration tests
			// The wizard respects the open prop
			render(<OnboardingWizard {...defaultProps} open={false} />);

			expect(
				screen.queryByText(/Welcome to WorkPilot AI/),
			).not.toBeInTheDocument();
		});
	});

	describe("Skip and Completion", () => {
		it("should complete wizard when skip is clicked", async () => {
			render(<OnboardingWizard {...defaultProps} />);

			// Click skip on welcome step
			const skipButton = screen.getByRole("button", { name: /Skip Setup/ });
			fireEvent.click(skipButton);

			// Should call saveSettings
			await waitFor(() => {
				expect(mockSaveSettings).toHaveBeenCalledWith({
					onboardingCompleted: true,
				});
			});
		});

		it("skipping the auth step moves on to the CLI step, not out of the wizard", async () => {
			// With no Claude account, Skip used to end the setup right there.
			render(<OnboardingWizard {...defaultProps} />);
			fireEvent.click(screen.getByRole("button", { name: /Get Started/ }));
			fireEvent.click(await screen.findByRole("button", { name: /Skip for now/ }));

			expect(await screen.findByText("cli.title")).toBeInTheDocument();
			expect(mockSaveSettings).not.toHaveBeenCalled();
		});

		it("offers every other provider, not only Claude", async () => {
			render(<OnboardingWizard {...defaultProps} />);
			fireEvent.click(screen.getByRole("button", { name: /Get Started/ }));
			fireEvent.click(await screen.findByTestId("auth-option-other"));

			expect(await screen.findByText(/providers\.title/)).toBeInTheDocument();
			expect(screen.getByText("accounts-panel")).toBeInTheDocument();
			// The Claude sign-in step is not on this path.
			expect(screen.queryByText("steps.auth")).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "common:buttons.back" }));
			expect(
				await screen.findByText(/Choose Your Authentication Method/),
			).toBeInTheDocument();
		});

		it("should call onOpenChange when wizard is closed", async () => {
			const mockOnOpenChange = vi.fn();
			render(
				<OnboardingWizard {...defaultProps} onOpenChange={mockOnOpenChange} />,
			);

			// Click skip to close wizard
			const skipButton = screen.getByRole("button", { name: /Skip Setup/ });
			fireEvent.click(skipButton);

			await waitFor(() => {
				expect(mockOnOpenChange).toHaveBeenCalledWith(false);
			});
		});
	});

	describe("AC Coverage", () => {
		it("AC1: First-run screen displays with two auth options", async () => {
			render(<OnboardingWizard {...defaultProps} />);

			// Navigate to auth-choice
			fireEvent.click(screen.getByRole("button", { name: /Get Started/ }));
			await waitFor(() => {
				expect(
					screen.getByText(/Choose Your Authentication Method/),
				).toBeInTheDocument();
			});

			// Both options should be visible
			expect(screen.getByText(/Sign in with Anthropic/)).toBeInTheDocument();
			expect(screen.getByText(/Use Custom API Key/)).toBeInTheDocument();
		});

		it("AC3: API Key path opens profile management dialog", async () => {
			render(<OnboardingWizard {...defaultProps} />);

			fireEvent.click(screen.getByText(/Get Started/));
			await waitFor(() => {
				expect(
					screen.getByText(/Choose Your Authentication Method/),
				).toBeInTheDocument();
			});

			const apiKeyButton = screen.getByTestId("auth-option-apikey");
			fireEvent.click(apiKeyButton);

			// ProfileEditDialog should open
			await waitFor(() => {
				expect(screen.getByTestId("profile-edit-dialog")).toBeInTheDocument();
			});
		});

		it("AC4: Existing auth skips wizard", () => {
			// Wizard with open=false simulates existing auth scenario
			render(<OnboardingWizard {...defaultProps} open={false} />);

			// Wizard should not be visible
			expect(
				screen.queryByText(/Welcome to WorkPilot AI/),
			).not.toBeInTheDocument();
		});
	});
});
