import { useTranslation } from "react-i18next";
import type {
	EngineTrio,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { isClaudeProvider } from "../../../shared/utils/task-engine";
import { useConfiguredProviders } from "../../hooks/useConfiguredProviders";
import { useProviderContext } from "../ProviderContext";
import { EngineTrioPicker } from "../task-engine/EngineTrioPicker";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

function sameProvider(a?: string | null, b?: string | null): boolean {
	if (isClaudeProvider(a) || isClaudeProvider(b)) {
		return isClaudeProvider(a) && isClaudeProvider(b);
	}
	return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * The second engine that reads a finished task before its pull request
 * (plan of 29 October, IA2; backend `cross_review/`).
 *
 * Off by default. On, it names a provider × model × effort; the backend
 * refuses one equal to the provider a task is built with, and this panel
 * says so before it happens. A disagreement holds the pull request back;
 * the person can still create it from the PR dialog.
 */
export function CrossReviewSettings({
	settings,
	setSettings,
}: {
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
}) {
	const { t } = useTranslation(["settings"]);
	const { selectedProvider } = useProviderContext();
	const { providers } = useConfiguredProviders();
	const buildProvider = settings.provider || selectedProvider || "anthropic";
	const engine = settings.crossReview;

	const seed = (): EngineTrio => ({
		provider:
			providers.find((p) => !sameProvider(p.name, buildProvider))?.name ??
			providers[0]?.name ??
			"openai",
		model: "",
		effort: "medium",
	});

	return (
		<div className="space-y-3 pt-2">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label htmlFor="cross-review" className="font-normal text-foreground">
						{t("projectSections.general.crossReview")}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t("projectSections.general.crossReviewDescription")}
					</p>
				</div>
				<Switch
					id="cross-review"
					checked={Boolean(engine)}
					onCheckedChange={(on) =>
						setSettings((prev) => ({
							...prev,
							crossReview: on ? seed() : undefined,
						}))
					}
				/>
			</div>
			{engine && (
				<>
					<EngineTrioPicker
						value={engine}
						onChange={(trio) =>
							setSettings((prev) => ({ ...prev, crossReview: trio }))
						}
						providers={providers}
						idPrefix="cross-review"
					/>
					{sameProvider(engine.provider, buildProvider) && (
						<p className="text-xs text-warning" role="alert">
							{t("projectSections.general.crossReviewSameProvider", {
								provider: buildProvider,
							})}
						</p>
					)}
				</>
			)}
		</div>
	);
}
