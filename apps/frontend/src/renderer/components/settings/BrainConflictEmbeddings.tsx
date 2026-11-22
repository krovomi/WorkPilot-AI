import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BrainEmbeddingsProvider,
	type BrainConflictEmbeddings as Embeddings,
	fetchBrainEmbeddingsFound,
} from "../../lib/agent-tools-api";
import { useBrainStore } from "../../stores/brain-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";

const PROVIDER_LABELS: Record<BrainEmbeddingsProvider, string> = {
	ollama: "brain:settings.embeddings.providerOllama",
	"lm-studio": "brain:settings.embeddings.providerLmStudio",
};

type Found =
	| { readonly state: "searching" }
	| { readonly state: "found"; readonly provider: BrainEmbeddingsProvider; readonly model: string }
	| { readonly state: "none" }
	| { readonly state: "unknown" };

/**
 * Memory conflicts found in other words, by an embeddings model a local
 * server already has: Ollama, else LM Studio, or the one chosen here
 * (`brain/lifecycle/embeddings.py`). Off, or without a model, a sync only
 * compares the notes' words. A variable that sets one of the settings wins,
 * so its control is read-only and says so. Which server and model a sync
 * would ask is asked of the backend apart, so the page never waits on it.
 */
export function BrainConflictEmbeddings({ embeddings }: { embeddings: Embeddings }) {
	const { t } = useTranslation(["brain"]);
	const saving = useBrainStore((s) => s.saving);
	const saveSettings = useBrainStore((s) => s.saveSettings);
	const [model, setModel] = useState(embeddings.model);
	const [found, setFound] = useState<Found>({ state: "searching" });
	const provider = embeddings.provider;

	useEffect(() => {
		setModel(embeddings.model);
	}, [embeddings.model]);

	// Asked again once each save is done: a setting changes what a sync would ask.
	useEffect(() => {
		if (!embeddings.enabled || saving) return;
		const controller = new AbortController();
		setFound({ state: "searching" });
		void fetchBrainEmbeddingsFound(controller.signal).then((res) => {
			if (controller.signal.aborted) return;
			if (!res.ok) setFound({ state: "unknown" });
			else if (res.data.found) setFound({ state: "found", ...res.data.found });
			else setFound({ state: "none" });
		});
		return () => controller.abort();
	}, [embeddings.enabled, saving]);

	return (
		<div className="space-y-2 rounded-lg border p-3">
			<div className="flex items-center justify-between gap-4">
				<div>
					<span className="text-sm font-medium">{t("brain:settings.embeddings.title")}</span>
					<p className="text-xs text-muted-foreground">{t("brain:settings.embeddings.hint")}</p>
				</div>
				<Switch
					checked={embeddings.enabled}
					disabled={saving || embeddings.enabledLocked}
					onCheckedChange={(checked) =>
						void saveSettings({ conflict_embeddings: checked, connect: false })
					}
					aria-label={t("brain:settings.embeddings.title")}
				/>
			</div>
			{embeddings.enabledLocked && (
				<p className="text-xs text-muted-foreground">
					{t("brain:settings.embeddings.locked", { variable: "BRAIN_CONFLICT_EMBEDDINGS" })}
				</p>
			)}
			{embeddings.enabled && found.state !== "unknown" && (
				<p className="text-xs" aria-live="polite">
					{found.state === "searching" && t("brain:settings.embeddings.searching")}
					{found.state === "found" &&
						t("brain:settings.embeddings.found", {
							model: found.model,
							provider: t(PROVIDER_LABELS[found.provider]),
						})}
					{found.state === "none" && t("brain:settings.embeddings.notFound")}
				</p>
			)}
			{provider !== undefined && (
				<>
					<label htmlFor="brain-embeddings-provider" className="text-sm font-medium">
						{t("brain:settings.embeddings.provider")}
					</label>
					<NativeSelect
						id="brain-embeddings-provider"
						className="w-full"
						value={provider}
						disabled={saving || embeddings.providerLocked}
						onChange={(e) =>
							void saveSettings({
								conflict_embeddings_provider: e.target.value as BrainEmbeddingsProvider | "",
								connect: false,
							})
						}
					>
						<option value="">{t("brain:settings.embeddings.providerAuto")}</option>
						<option value="ollama">{t(PROVIDER_LABELS.ollama)}</option>
						<option value="lm-studio">{t(PROVIDER_LABELS["lm-studio"])}</option>
					</NativeSelect>
					<p className="text-xs text-muted-foreground">
						{embeddings.providerLocked
							? t("brain:settings.embeddings.locked", {
									variable: "BRAIN_CONFLICT_EMBEDDINGS_PROVIDER",
								})
							: t("brain:settings.embeddings.providerHint")}
					</p>
				</>
			)}
			<label htmlFor="brain-embeddings-model" className="text-sm font-medium">
				{t("brain:settings.embeddings.model")}
			</label>
			<div className="flex gap-2">
				<Input
					id="brain-embeddings-model"
					value={model}
					disabled={saving || embeddings.modelLocked}
					onChange={(e) => setModel(e.target.value)}
					placeholder={t("brain:settings.embeddings.modelPlaceholder")}
				/>
				<Button
					variant="outline"
					disabled={saving || embeddings.modelLocked || model.trim() === embeddings.model}
					onClick={() =>
						void saveSettings({ conflict_embeddings_model: model.trim(), connect: false })
					}
				>
					{t("brain:settings.embeddings.save")}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{embeddings.modelLocked
					? t("brain:settings.embeddings.locked", {
							variable: "BRAIN_CONFLICT_EMBEDDINGS_MODEL",
						})
					: t("brain:settings.embeddings.modelHint")}
			</p>
		</div>
	);
}
