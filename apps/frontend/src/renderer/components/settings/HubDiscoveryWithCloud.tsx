/**
 * The Hub model search of the local provider page, with « Try in the cloud »:
 * a repo that the Hugging Face router serves can become the Hugging Face
 * provider's model at once, so a task runs it there before anyone downloads
 * it. The router's catalogue comes from the backend; saving the model goes
 * through the settings store, like every other setting.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { indexCatalog } from "./gateway-model-catalog";
import { HuggingFaceModelDiscovery } from "./HuggingFaceModelDiscovery";

interface HubDiscoveryWithCloudProps {
	readonly className?: string;
	readonly hfToken?: string;
	readonly selectedModel?: string;
	readonly baseUrl?: string;
	readonly onSelectModel: (model: string) => void;
}

type CloudNotice = { kind: "chosen" | "failed"; id: string } | null;

export function HubDiscoveryWithCloud(props: HubDiscoveryWithCloudProps) {
	const { t } = useTranslation("settings");
	const { models } = useProviderModelCatalog("huggingface");
	const cloudIndex = useMemo(() => indexCatalog(models), [models]);
	const cloudModel = useSettingsStore((s) => s.settings.globalHuggingFaceModel);
	const hasToken = useSettingsStore((s) => !!s.settings.globalHuggingFaceApiKey);
	const [notice, setNotice] = useState<CloudNotice>(null);

	const tryInCloud = async (id: string) => {
		const saved = await saveSettings({ globalHuggingFaceModel: id });
		setNotice({ kind: saved ? "chosen" : "failed", id });
	};

	return (
		<div className={props.className}>
			{notice && (
				<div
					role="status"
					className="mb-2 rounded-md border border-info/30 bg-info/5 p-2 text-xs text-foreground"
				>
					{notice.kind === "chosen" ? (
						<>
							<p>
								{t("sections.accounts.modelDiscovery.cloudChosen", {
									id: notice.id,
								})}
							</p>
							{!hasToken && (
								<p className="mt-1 text-warning">
									{t("sections.accounts.modelDiscovery.cloudNeedsToken")}
								</p>
							)}
						</>
					) : (
						<p className="text-destructive">
							{t("sections.accounts.modelDiscovery.cloudSaveFailed")}
						</p>
					)}
				</div>
			)}
			<HuggingFaceModelDiscovery
				hfToken={props.hfToken}
				selectedModel={props.selectedModel}
				baseUrl={props.baseUrl}
				onSelectModel={props.onSelectModel}
				cloudIndex={cloudIndex}
				cloudModel={cloudModel}
				onTryInCloud={(id) => void tryInCloud(id)}
			/>
		</div>
	);
}
