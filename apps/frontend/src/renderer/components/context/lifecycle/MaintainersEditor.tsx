import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { errorLabel } from "./lifecycle-labels";

interface MaintainersEditorProps {
	readonly projectId: string;
	readonly maintainers: string[];
	readonly onSaved: () => void;
}

/** Who settles a conflict that flip-flops: names or e-mails, kept in the vault. */
export function MaintainersEditor({ projectId, maintainers, onSaved }: MaintainersEditorProps) {
	const { t } = useTranslation(["context"]);
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = async (text: string) => {
		const names = text
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		const result = await window.electronAPI.setMemoryMaintainers(projectId, names);
		if (result.success) {
			setDraft(null);
			setError(null);
			onSaved();
		} else {
			setError(errorLabel(t, result.error));
		}
	};

	return (
		<div className="space-y-2 text-xs text-muted-foreground" data-testid="memory-maintainers">
			<div className="flex flex-wrap items-center gap-2">
				<ShieldCheck className="h-3.5 w-3.5" />
				<span>
					{maintainers.length > 0
						? t("context:lifecycle.maintainers.list", { names: maintainers.join(", ") })
						: t("context:lifecycle.maintainers.none")}
				</span>
				{draft === null && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						onClick={() => setDraft(maintainers.join(", "))}
					>
						{t("context:lifecycle.maintainers.edit")}
					</Button>
				)}
			</div>
			{draft !== null && (
				<div className="flex gap-2">
					<Input
						value={draft}
						placeholder={t("context:lifecycle.maintainers.placeholder")}
						aria-label={t("context:lifecycle.maintainers.placeholder")}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button size="sm" onClick={() => save(draft)}>
						{t("context:lifecycle.maintainers.save")}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
						{t("context:lifecycle.maintainers.cancel")}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
