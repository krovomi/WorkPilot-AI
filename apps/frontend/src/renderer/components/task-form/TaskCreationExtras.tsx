import {
	ChevronDown,
	ChevronRight,
	ListChecks,
	StickyNote,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AcceptanceCriteriaEditor } from "../task-detail/AcceptanceCriteriaEditor";
import { type AcEditorMode, AcModeToggle } from "../task-detail/AcModeToggle";
import {
	type CriterionDraft,
	draftsToText,
	ensureAtLeastOne,
	sameCriteria,
	textToDrafts,
	toCriteria,
} from "../task-detail/acceptance-criteria-draft";
import { Badge } from "../ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import { Textarea } from "../ui/textarea";

interface TaskCreationExtrasProps {
	readonly criteria: readonly CriterionDraft[];
	readonly onCriteriaChange: (next: CriterionDraft[]) => void;
	readonly extraNote: string;
	readonly onExtraNoteChange: (next: string) => void;
	readonly disabled?: boolean;
}

/**
 * Les critères d'acceptation et la note supplémentaire, dès la création.
 *
 * Les deux champs n'existaient que dans le panneau d'une tâche déjà créée, si
 * bien qu'une tâche lancée depuis l'assistant partait sans eux : il fallait la
 * créer, la rouvrir, les ajouter, puis seulement la démarrer. Le backend les
 * attendait pourtant déjà à la création (`TASK_CREATE` recopie
 * `acceptanceCriteria` et `extraNote` dans `requirements.json`) — seule l'UI
 * manquait.
 *
 * Même éditeur, mêmes deux modes que dans le panneau de la tâche : une seule
 * façon d'écrire un critère dans le produit.
 */
export function TaskCreationExtras({
	criteria,
	onCriteriaChange,
	extraNote,
	onExtraNoteChange,
	disabled = false,
}: TaskCreationExtrasProps) {
	const { t } = useTranslation(["tasks"]);
	const noteId = useId();
	const count = toCriteria(criteria).length;
	const [acOpen, setAcOpen] = useState(count > 0);
	const [noteOpen, setNoteOpen] = useState(extraNote.trim().length > 0);
	const [mode, setMode] = useState<AcEditorMode>("list");
	// Le mode texte garde sa chaîne : la recalculer depuis les puces à chaque
	// frappe supprimerait la ligne vide qu'on vient d'ouvrir.
	const [text, setText] = useState("");

	// La liste vient du parent : « Ignorer le brouillon » la vide pendant que le
	// mode texte est ouvert. Sans cette resynchronisation, le champ montrerait
	// l'ancien texte et la frappe suivante le renverrait au parent. Une liste
	// qui dit la même chose que le texte est celle qu'on vient d'émettre, et on
	// ne touche pas au texte — sinon la ligne vide qu'on tape disparaîtrait.
	useEffect(() => {
		if (mode !== "text") return;
		setText((current) =>
			sameCriteria(toCriteria(textToDrafts(current)), toCriteria(criteria))
				? current
				: draftsToText(criteria),
		);
	}, [criteria, mode]);

	const switchMode = (next: AcEditorMode) => {
		if (next === mode) return;
		if (next === "text") setText(draftsToText(criteria));
		else onCriteriaChange(ensureAtLeastOne(textToDrafts(text)));
		setMode(next);
	};

	return (
		<div className="space-y-3">
			<Collapsible open={acOpen} onOpenChange={setAcOpen}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
						aria-expanded={acOpen}
					>
						{acOpen ? (
							<ChevronDown className="h-4 w-4" aria-hidden="true" />
						) : (
							<ChevronRight className="h-4 w-4" aria-hidden="true" />
						)}
						<ListChecks className="h-4 w-4 text-success" aria-hidden="true" />
						<span>{t("tasks:metadata.acceptanceCriteria")}</span>
						{count > 0 && (
							<Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">
								{count}
							</Badge>
						)}
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-2">
					<div className="flex justify-end mb-1.5">
						<AcModeToggle mode={mode} onChange={switchMode} />
					</div>
					{mode === "list" ? (
						<AcceptanceCriteriaEditor
							drafts={criteria}
							onChange={onCriteriaChange}
							disabled={disabled}
						/>
					) : (
						<Textarea
							value={text}
							onChange={(e) => {
								setText(e.target.value);
								onCriteriaChange(ensureAtLeastOne(textToDrafts(e.target.value)));
							}}
							placeholder={t("tasks:metadata.acPlaceholder")}
							rows={5}
							className="text-sm"
							disabled={disabled}
						/>
					)}
					<p className="mt-1.5 text-xs text-muted-foreground">
						{mode === "list"
							? t("tasks:wizard.extras.acListHelp")
							: t("tasks:wizard.extras.acTextHelp")}
					</p>
				</CollapsibleContent>
			</Collapsible>

			<Collapsible open={noteOpen} onOpenChange={setNoteOpen}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
						aria-expanded={noteOpen}
					>
						{noteOpen ? (
							<ChevronDown className="h-4 w-4" aria-hidden="true" />
						) : (
							<ChevronRight className="h-4 w-4" aria-hidden="true" />
						)}
						<StickyNote className="h-4 w-4 text-warning" aria-hidden="true" />
						<span>{t("tasks:metadata.extraNote")}</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-2">
					<label htmlFor={noteId} className="sr-only">
						{t("tasks:metadata.extraNote")}
					</label>
					<Textarea
						id={noteId}
						value={extraNote}
						onChange={(e) => onExtraNoteChange(e.target.value)}
						placeholder={t("tasks:metadata.extraNotePlaceholder")}
						rows={4}
						className="text-sm"
						disabled={disabled}
					/>
					<p className="mt-1.5 text-xs text-muted-foreground">
						{t("tasks:wizard.extras.noteHelp")}
					</p>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
