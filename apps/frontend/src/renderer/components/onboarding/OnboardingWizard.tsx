import { Wand2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settings-store";
import { useShallow } from "zustand/react/shallow";
import {
	FullScreenDialog,
	FullScreenDialogBody,
	FullScreenDialogContent,
	FullScreenDialogDescription,
	FullScreenDialogHeader,
	FullScreenDialogTitle,
} from "../ui/full-screen-dialog";
import { ScrollArea } from "../ui/scroll-area";
import { AuthChoiceStep } from "./AuthChoiceStep";
import { ClaudeCodeStep } from "./ClaudeCodeStep";
import { CompletionStep } from "./CompletionStep";
import { DevToolsStep } from "./DevToolsStep";
import { OAuthStep } from "./OAuthStep";
import { PrivacyStep } from "./PrivacyStep";
import { WelcomeStep } from "./WelcomeStep";
import { WIZARD_STEPS, type WizardStepId } from "./wizard-steps";
import { WizardProgress, type WizardStep } from "./WizardProgress";

interface OnboardingWizardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenTaskCreator?: () => void;
	onOpenSettings?: () => void;
}

/**
 * Main onboarding wizard component.
 * Provides a full-screen, multi-step wizard experience for new users
 * to configure their WorkPilot AI environment.
 *
 * Features:
 * - Step progress indicator
 * - Navigation between steps (next, back, skip)
 * - Persists completion state to settings
 * - Can be re-run from settings
 */
export function OnboardingWizard({
	open,
	onOpenChange,
	onOpenTaskCreator,
	onOpenSettings,
}: OnboardingWizardProps) {
	const { t } = useTranslation("onboarding");
	const { updateSettings } = useSettingsStore(
		useShallow((s) => ({
			updateSettings: s.updateSettings,
		})),
	);
	const [currentStepIndex, setCurrentStepIndex] = useState(0);
	const [completedSteps, setCompletedSteps] = useState<Set<WizardStepId>>(
		new Set(),
	);
	// Track if oauth step was bypassed (API key path chosen)
	const [oauthBypassed, setOauthBypassed] = useState(false);

	// Get current step ID
	const currentStepId = WIZARD_STEPS[currentStepIndex].id;

	// Build step data for progress indicator
	const steps: WizardStep[] = WIZARD_STEPS.map((step, index) => ({
		id: step.id,
		label: t(step.labelKey),
		completed: completedSteps.has(step.id) || index < currentStepIndex,
	}));

	// Navigation handlers
	const goToNextStep = useCallback(() => {
		// Mark current step as completed
		setCompletedSteps((prev) => new Set(prev).add(currentStepId));

		// If leaving auth-choice, reset oauth bypassed flag
		if (currentStepId === "auth-choice") {
			setOauthBypassed(false);
		}

		if (currentStepIndex < WIZARD_STEPS.length - 1) {
			setCurrentStepIndex((prev) => prev + 1);
		}
	}, [currentStepIndex, currentStepId]);

	const goToPreviousStep = useCallback(() => {
		// If going back from completion and oauth was bypassed, go back to auth-choice (skip oauth)
		if (currentStepId === "completion" && oauthBypassed) {
			// Find index of auth-choice step
			const authChoiceIndex = WIZARD_STEPS.findIndex(
				(step) => step.id === "auth-choice",
			);
			setCurrentStepIndex(authChoiceIndex);
			setOauthBypassed(false);
			return;
		}

		if (currentStepIndex > 0) {
			setCurrentStepIndex((prev) => prev - 1);
		}
	}, [currentStepIndex, currentStepId, oauthBypassed]);

	// Handler for when API key path is chosen - skips oauth step
	const handleSkipToCompletion = useCallback(() => {
		setOauthBypassed(true);
		setCompletedSteps((prev) => new Set(prev).add("auth-choice"));

		// Find index of completion step
		const completionIndex = WIZARD_STEPS.findIndex(
			(step) => step.id === "completion",
		);
		setCurrentStepIndex(completionIndex);
	}, []);

	// "Skip" inside a step skips that step, not the rest of the wizard: on a
	// machine with no Claude account it ended the setup at the auth step, and
	// the CLI, dev tools and privacy steps were never shown.
	const skipAuthentication = useCallback(() => {
		setCurrentStepIndex(WIZARD_STEPS.findIndex((step) => step.id === "claude-code"));
	}, []);

	// Reset wizard state (for re-running) - defined before skipWizard/finishWizard that use it
	const resetWizard = useCallback(() => {
		setCurrentStepIndex(0);
		setCompletedSteps(new Set());
		setOauthBypassed(false);
	}, []);

	const completeWizard = useCallback(async () => {
		// Mark onboarding as completed and close - save to disk AND update local state
		try {
			const result = await window.electronAPI.saveSettings({
				onboardingCompleted: true,
			});
			if (!result?.success) {
				console.error("Failed to save onboarding completion:", result?.error);
			}
		} catch (err) {
			console.error("Error saving onboarding completion:", err);
		}
		updateSettings({ onboardingCompleted: true });
		onOpenChange(false);
		resetWizard();
	}, [updateSettings, onOpenChange, resetWizard]);

	// Handle opening task creator from within wizard
	const handleOpenTaskCreator = useCallback(() => {
		if (onOpenTaskCreator) {
			// Finish the wizard (saved), then open the task creator: only closing
			// it left onboardingCompleted false and it came back on the next start.
			void completeWizard();
			onOpenTaskCreator();
		}
	}, [onOpenTaskCreator, completeWizard]);

	// Handle opening settings from completion step
	const handleOpenSettings = useCallback(() => {
		if (onOpenSettings) {
			// Finish wizard first, then open settings
			completeWizard();
			onOpenSettings();
		}
	}, [onOpenSettings, completeWizard]);

	// Render current step content
	const renderStepContent = () => {
		switch (currentStepId) {
			case "welcome":
				return (
					<WelcomeStep onGetStarted={goToNextStep} onSkip={completeWizard} />
				);
			case "auth-choice":
				return (
					<AuthChoiceStep
						onNext={goToNextStep}
						onBack={goToPreviousStep}
						onSkip={skipAuthentication}
						onAPIKeyPathComplete={handleSkipToCompletion}
					/>
				);
			case "oauth":
				return (
					<OAuthStep
						onNext={goToNextStep}
						onBack={goToPreviousStep}
						onSkip={goToNextStep}
					/>
				);
			case "claude-code":
				return (
					<ClaudeCodeStep
						onNext={goToNextStep}
						onBack={goToPreviousStep}
						onSkip={goToNextStep}
					/>
				);
			case "devtools":
				return <DevToolsStep onNext={goToNextStep} onBack={goToPreviousStep} />;
			case "privacy":
				return <PrivacyStep onNext={goToNextStep} onBack={goToPreviousStep} />;
			case "completion":
				return (
					<CompletionStep
						onFinish={completeWizard}
						onOpenTaskCreator={handleOpenTaskCreator}
						onOpenSettings={handleOpenSettings}
					/>
				);
			default:
				return null;
		}
	};

	// Handle dialog close - ask for confirmation if not completed
	const handleOpenChange = useCallback(
		(newOpen: boolean) => {
			if (!newOpen) {
				// If closing before completion, skip the wizard
				completeWizard();
			} else {
				onOpenChange(newOpen);
			}
		},
		[completeWizard, onOpenChange],
	);

	return (
		<FullScreenDialog open={open} onOpenChange={handleOpenChange}>
			<FullScreenDialogContent>
				<FullScreenDialogHeader>
					<FullScreenDialogTitle className="flex items-center gap-3">
						<Wand2 className="h-6 w-6" />
						{t("wizard.title")}
					</FullScreenDialogTitle>
					<FullScreenDialogDescription>
						{t("wizard.description")}
					</FullScreenDialogDescription>

					{/* Progress indicator - show for all steps except welcome and completion */}
					{currentStepId !== "welcome" && currentStepId !== "completion" && (
						<div className="mt-6">
							<WizardProgress currentStep={currentStepIndex} steps={steps} />
						</div>
					)}
				</FullScreenDialogHeader>

				<FullScreenDialogBody>
					<ScrollArea className="h-full">{renderStepContent()}</ScrollArea>
				</FullScreenDialogBody>
			</FullScreenDialogContent>
		</FullScreenDialog>
	);
}
