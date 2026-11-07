import type { PointedElementSummary } from "@shared/types/preview-point";
import { FileCode, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAX_STEERING_CHARS } from "../../../shared/utils/steering";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface PointedDraft {
	element: PointedElementSummary;
	text: string;
}

interface PointedElementsPanelProps {
	readonly drafts: readonly PointedDraft[];
	readonly busy: boolean;
	readonly error: string | null;
	readonly sentNote: string | null;
	readonly onChange: (id: string, text: string) => void;
	readonly onRemove: (id: string) => void;
	readonly onSend: () => void;
}

/**
 * Les éléments pointés dans l'aperçu (F10), chacun avec ce qu'il faut y
 * changer. « Envoyer » fait un message de guidage par élément (F1) : la
 * prochaine session de la tâche le reçoit avec l'élément, son chemin dans la
 * page et les fichiers qui le rendent probablement.
 */
export function PointedElementsPanel({
	drafts,
	busy,
	error,
	sentNote,
	onChange,
	onRemove,
	onSend,
}: PointedElementsPanelProps) {
	const { t } = useTranslation("appEmulator");
	if (drafts.length === 0 && !sentNote && !error) return null;
	const ready = drafts.length > 0 && drafts.every((d) => d.text.trim());

	return (
		<section
			className="shrink-0 max-h-72 overflow-auto border-t border-border p-3 space-y-2"
			aria-label={t("pointPanel.title")}
		>
			{drafts.length > 0 && (
				<div>
					<h4 className="text-sm font-medium text-foreground">{t("pointPanel.title")}</h4>
					<p className="text-xs text-muted-foreground">{t("pointPanel.description")}</p>
				</div>
			)}
			<ul className="space-y-2">
				{drafts.map(({ element, text }) => (
					<li key={element.id} className="flex gap-2 rounded-md border border-border p-2">
						{element.image && (
							<img
								src={element.image}
								alt={t("pointPanel.imageAlt", { selector: element.selector })}
								className="h-16 w-24 shrink-0 rounded border border-border object-contain bg-white"
							/>
						)}
						<div className="min-w-0 flex-1 space-y-1">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<code className="block truncate text-xs text-foreground">
										{element.selector}
									</code>
									{element.text && (
										<p className="truncate text-xs text-muted-foreground">« {element.text} »</p>
									)}
								</div>
								<Button
									size="icon"
									variant="ghost"
									className="h-6 w-6 shrink-0"
									aria-label={t("pointPanel.remove", { selector: element.selector })}
									title={t("pointPanel.remove", { selector: element.selector })}
									onClick={() => onRemove(element.id)}
								>
									<X className="h-3 w-3" />
								</Button>
							</div>
							<p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
								<FileCode className="h-3 w-3 shrink-0" aria-hidden />
								{element.candidates.length > 0
									? element.candidates
											.slice(0, 2)
											.map((c) => `${c.path}:${c.line}`)
											.join(", ")
									: t("pointPanel.noSource")}
							</p>
							<Textarea
								value={text}
								onChange={(event) => onChange(element.id, event.target.value)}
								maxLength={MAX_STEERING_CHARS}
								rows={2}
								placeholder={t("pointPanel.placeholder")}
								aria-label={t("pointPanel.instruction", { selector: element.selector })}
							/>
						</div>
					</li>
				))}
			</ul>
			{drafts.length > 0 && (
				<div className="flex justify-end">
					<Button size="sm" disabled={busy || !ready} onClick={onSend}>
						<Send className="mr-1 h-3 w-3" aria-hidden />
						{t("pointPanel.send", { count: drafts.length })}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			{sentNote && (
				<p role="status" className="text-xs text-muted-foreground">
					{sentNote}
				</p>
			)}
		</section>
	);
}
