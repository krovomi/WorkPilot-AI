import { Loader2, Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { type FigmaImportResult, linkFigmaMockup } from "../../lib/agent-tools-api";
import { useDocintelStore } from "../../stores/docintel-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface FigmaLinkRowProps {
	readonly task: Task;
	readonly projectPath: string;
}

/**
 * Lier une maquette Figma à la tâche.
 *
 * Le lien part au backend, qui lit les frames et les textes par l'API Figma
 * avec le jeton du projet — que ce composant ne voit jamais — et écrit
 * `attachments/<nom>.figma.json`. Ce fichier est ensuite une pièce jointe
 * comme une autre : relu par le préflight, et source structurée de la
 * comparaison maquette / rendu.
 */
export function FigmaLinkRow({ task, projectPath }: FigmaLinkRowProps) {
	const { t } = useTranslation(["tasks"]);
	const load = useDocintelStore((s) => s.load);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<FigmaImportResult | null>(null);
	const [failed, setFailed] = useState(false);

	const query = {
		specDir: task.specsPath,
		projectDir: projectPath,
		specId: task.specId,
	};

	const submit = async () => {
		setBusy(true);
		setFailed(false);
		setResult(null);
		const res = await linkFigmaMockup(query, url.trim());
		setBusy(false);
		if (!res.ok) {
			setFailed(true);
			return;
		}
		setResult(res.data.result);
		if (res.data.result.status === "imported") {
			setUrl("");
			void load({ taskId: task.id, ...query });
		}
	};

	return (
		<section className="border-t border-border px-3 py-2">
			<div className="flex items-center gap-2">
				<Palette className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
				<Input
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder={t("tasks:docintel.figma.placeholder")}
					aria-label={t("tasks:docintel.figma.label")}
					className="h-8 text-xs"
				/>
				<Button
					size="sm"
					variant="outline"
					disabled={busy || url.trim() === ""}
					onClick={() => void submit()}
				>
					{busy ? (
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
					) : (
						t("tasks:docintel.figma.link")
					)}
				</Button>
			</div>
			{failed && (
				<p className="mt-1 text-xs text-destructive">
					{t("tasks:docintel.figma.status.failed")}
				</p>
			)}
			{result && result.status === "imported" && (
				<p className="mt-1 text-xs text-muted-foreground">
					{t("tasks:docintel.figma.imported", {
						frames: result.frames,
						texts: result.texts,
						path: result.path,
					})}
					{result.withheld > 0 &&
						` ${t("tasks:docintel.figma.withheld", { count: result.withheld })}`}
					{result.secrets.length > 0 &&
						` ${t("tasks:docintel.figma.secrets", { kinds: result.secrets.join(", ") })}`}
				</p>
			)}
			{result && result.status !== "imported" && (
				<p className="mt-1 text-xs text-destructive">
					{t(`tasks:docintel.figma.status.${figmaStatusKey(result.status)}`)}
				</p>
			)}
		</section>
	);
}

const KNOWN_STATUSES = new Set([
	"invalid-url",
	"no-token",
	"airgap",
	"network",
	"too-large",
	"empty",
	"injection",
	"unwritable",
	"secret-scan-unavailable",
]);

/** A known reason, `http` for any HTTP error, `failed` for the rest. */
export function figmaStatusKey(status: string): string {
	if (KNOWN_STATUSES.has(status)) return status;
	if (status.startsWith("http-")) return "http";
	return "failed";
}
