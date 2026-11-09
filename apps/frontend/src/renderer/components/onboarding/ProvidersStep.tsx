import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { AppSettings } from "@shared/types/settings";
import { useSettingsStore } from "../../stores/settings-store";
import { CleanProviderSection } from "../settings/CleanProviderSection";
import { Button } from "../ui/button";

interface ProvidersStepProps {
	readonly onNext: () => void;
	readonly onBack: () => void;
}

/**
 * The wizard's « Use another AI » step: the Settings → Accounts panel itself,
 * so every provider it knows (OpenAI Codex, GitHub Copilot, Gemini CLI,
 * OpenCode, pi, Antigravity, Ollama, Mistral…) can be signed in, installed or
 * given a key on a first start, with the same checks as later in Settings.
 * The wizard used to offer Claude only.
 */
export function ProvidersStep({ onNext, onBack }: ProvidersStepProps) {
	const { t } = useTranslation(["onboarding", "common"]);
	const { settings, updateSettings } = useSettingsStore(
		useShallow((s) => ({ settings: s.settings, updateSettings: s.updateSettings })),
	);

	return (
		<div className="flex h-full flex-col px-8 py-6">
			<div className="mx-auto w-full max-w-6xl">
				<div className="text-center mb-6">
					<div className="flex justify-center mb-4">
						<div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
							<Bot className="h-8 w-8 text-primary" />
						</div>
					</div>
					<h1 className="text-3xl font-bold text-foreground tracking-tight">
						{t("onboarding:providers.title")}
					</h1>
					<p className="mt-3 text-muted-foreground">
						{t("onboarding:providers.description")}
					</p>
				</div>

				{/* The panel saves each change to disk itself. */}
				<CleanProviderSection
					settings={settings as AppSettings & Record<string, unknown>}
					onSettingsChange={(next) => updateSettings(next)}
					isOpen
				/>

				<div className="flex justify-center gap-4 mt-8">
					<Button
						size="lg"
						variant="outline"
						onClick={onBack}
						className="text-muted-foreground hover:text-foreground"
					>
						{t("common:buttons.back")}
					</Button>
					<Button size="lg" onClick={onNext}>
						{t("onboarding:providers.continue")}
					</Button>
				</div>
			</div>
		</div>
	);
}
