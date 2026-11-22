import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrainConflictEmbeddings as Embeddings } from "../../lib/agent-tools-api";
import { useBrainStore } from "../../stores/brain-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/**
 * Memory conflicts found in other words, by an embeddings model Ollama already
 * has (`brain/lifecycle/embeddings.py`). Off, or without a model, a sync only
 * compares the notes' words. A variable that sets one of the two settings
 * wins, so its control is read-only and says so.
 */
export function BrainConflictEmbeddings({ embeddings }: { embeddings: Embeddings }) {
	const { t } = useTranslation(["brain"]);
	const saving = useBrainStore((s) => s.saving);
	const saveSettings = useBrainStore((s) => s.saveSettings);
	const [model, setModel] = useState(embeddings.model);

	useEffect(() => {
		setModel(embeddings.model);
	}, [embeddings.model]);

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
