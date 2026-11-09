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
import { ProvidersStep } from "./ProvidersStep";
import {
	neighbourStep,
	stepsForPath,
	type WizardPath,
	type WizardStepId,
} from "./wizard-steps";
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
	const [currentStepId, setCurrentStepId] = useState<WizardStepId>("welcome");
	const [completedSteps, setCompletedSteps] = useState<Set<WizardStepId>>(
		new Set(),
	);
	// The path chosen on the « Choose your AI » step decides which steps follow.
	const [path, setPath] = useState<WizardPath>("undecided");

	const visibleSteps = stepsForPath(path);
	const currentStepIndex = Math.max(
		0,
		visibleSteps.findIndex((step) => step.id === currentStepId),
	);

	// Build step data for progress indicator
	const steps: WizardStep[] = visibleSteps.map((step, index) => ({
		id: step.id,
		label: t(step.labelKey),
		completed: completedSteps.has(step.id) || index < currentStepIndex,
	}));

	// Navigation handlers
	const goToNextStep = useCallback(() => {
		setCompletedSteps((prev) => new Set(prev).add(currentStepId));
		setCurrentStepId(neighbourStep(path, currentStepId, 1));
	}, [path, currentStepId]);

	const goToPreviousStep = useCallback(() => {
		const previous = neighbourStep(path, currentStepId, -1);
		// Back on the choice screen, the choice is open again.
		if (previous === "auth-choice") setPath("undecided");
		setCurrentStepId(previous);
	}, [path, currentStepId]);

	// Leave the choice screen on a path: its steps follow, then the common ones.
	const choosePath = useCallback((chosen: WizardPath) => {
		setPath(chosen);
		setCompletedSteps((prev) => new Set(prev).add("auth-choice"));
		setCurrentStepId(neighbourStep(chosen, "auth-choice", 1));
	}, []);

	// From the last screen with no AI connected: straight to the providers.
	const connectProvider = useCallback(() => {
		setPath("other");
		setCurrentStepId("providers");
	}, []);

	// Reset wizard state (for re-running) - defined before skipWizard/finishWizard that use it
	const resetWizard = useCallback(() => {
		setCurrentStepId("welcome");
		setCompletedSteps(new Set());
		setPath("undecided");
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
						onNext={() => choosePath("claude")}
						onBack={goToPreviousStep}
						// "Skip" skips this step, not the rest of the wizard.
						onSkip={() => choosePath("skipped")}
						onAPIKeyPathComplete={() => choosePath("api-key")}
						onOtherProvider={() => choosePath("other")}
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
			case "providers":
				return <ProvidersStep onNext={goToNextStep} onBack={goToPreviousStep} />;
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
						onConnectProvider={connectProvider}
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
