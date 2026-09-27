import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrainSettings } from "../settings/BrainSettings";
import { Button } from "../ui/button";

interface MemoryStepProps {
	onNext: () => void;
	onBack: () => void;
}

/**
 * Onboarding: where WorkPilot keeps what it learns.
 *
 * Memory is the shared brain — one Obsidian vault every agent reads and
 * writes (`apps/backend/brain/project_memory.py`). This step used to configure
 * Graphiti (LadybugDB, an embedding provider, an LLM for entity extraction),
 * one of the several stores memory was spread across. There is nothing left to
 * configure for memory to work: the vault is created by the first build. What
 * this step offers is the choice a person may want to make up front — plug in
 * an Obsidian vault they already have, or a git remote to sync it — through
 * the same `BrainSettings` panel as Settings → Integrations.
 */
export function MemoryStep({ onNext, onBack }: MemoryStepProps) {
	const { t } = useTranslation("onboarding");

	return (
		<div className="flex h-full flex-col items-center justify-center px-8 py-6">
			<div className="w-full max-w-2xl">
				<div className="text-center mb-8">
					<div className="flex justify-center mb-4">
						<div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Brain className="h-7 w-7" />
						</div>
					</div>
					<h1 className="text-2xl font-bold text-foreground tracking-tight">
						{t("memory.title")}
					</h1>
					<p className="mt-2 text-muted-foreground">
						{t("memory.description")}
					</p>
				</div>

				<div className="rounded-lg border border-info/30 bg-info/10 p-4 mb-6">
					<p className="text-sm text-muted-foreground">
						{t("memory.brainExplanation")}
					</p>
				</div>

				<BrainSettings />

				<div className="flex justify-between items-center mt-10 pt-6 border-t border-border">
					<Button
						variant="ghost"
						onClick={onBack}
						className="text-muted-foreground hover:text-foreground"
					>
						{t("memory.back")}
					</Button>
					<Button onClick={onNext}>{t("memory.continue")}</Button>
				</div>
			</div>
		</div>
	);
}
