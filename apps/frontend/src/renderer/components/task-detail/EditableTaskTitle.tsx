import { Pencil } from "lucide-react";
import {
	type ElementType,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { persistUpdateTask } from "../../stores/task-store";

interface EditableTaskTitleProps {
	readonly task: Task;
	/** Le titre tel qu'il est affiché (HTML retiré, suffixes traduits). */
	readonly displayTitle: string;
	/** Faux pendant qu'un agent tourne : la même règle que le crayon de l'en-tête. */
	readonly editable: boolean;
	/** L'élément titre du dialogue (Radix `Dialog.Title`), pour garder son rôle. */
	readonly as: ElementType<{ className?: string; children?: ReactNode }>;
	readonly className?: string;
}

/**
 * Le titre de la tâche, modifiable d'un clic.
 *
 * Passer par la boîte d'édition complète pour corriger une faute de frappe
 * dans un titre, c'est ouvrir un formulaire de cinq sections pour changer un
 * mot. Ici le titre *est* le champ : un clic l'ouvre, Entrée ou un clic
 * ailleurs enregistre, Échap annule.
 *
 * Un titre vidé n'est pas enregistré : le main process en génère un à partir
 * de la description quand il reçoit une chaîne vide, et un clic malheureux ne
 * doit pas remplacer un titre choisi par un titre inventé. On revient à
 * l'ancien, sans rien écrire.
 */
export function EditableTaskTitle({
	task,
	displayTitle,
	editable,
	as: Title,
	className,
}: EditableTaskTitleProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(displayTitle);
	const [saving, setSaving] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	// Entrée enregistre puis le champ perd le focus : sans ce drapeau, le blur
	// qui suit relancerait un second enregistrement du même texte.
	const settled = useRef(false);
	// Le numéro du dernier enregistrement lancé : seul celui-là agit sur le
	// champ en se terminant (le rendre, le fermer, y remettre le focus).
	// Changer de tâche l'incrémente aussi, si bien qu'un aller-retour A → B → A
	// ne rend pas au champ rouvert sur A l'issue d'un enregistrement d'avant.
	const saveSeq = useRef(0);

	useEffect(() => {
		if (!editing) setDraft(displayTitle);
	}, [displayTitle, editing]);

	useEffect(() => {
		if (editing) {
			input.current?.focus();
			input.current?.select();
		}
	}, [editing]);

	// Un agent qui démarre pendant l'édition referme le champ sans écrire.
	useEffect(() => {
		if (!editable) setEditing(false);
	}, [editable]);

	// Le dialogue navigue d'une tâche à l'autre sans démonter ce composant : un
	// champ encore ouvert enregistrerait le titre de l'une sous l'id de l'autre.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new task closes the field
	useEffect(() => {
		settled.current = true;
		setEditing(false);
		// Un enregistrement de la tâche quittée ne tient plus ce champ en attente.
		saveSeq.current += 1;
		setSaving(false);
	}, [task.id]);

	const open = () => {
		if (!editable) return;
		settled.current = false;
		setDraft(displayTitle);
		setEditing(true);
	};

	const cancel = () => {
		settled.current = true;
		setDraft(displayTitle);
		setEditing(false);
	};

	const commit = async () => {
		if (settled.current) return;
		settled.current = true;
		const next = draft.replace(/\s+/g, " ").trim();
		if (!next || next === displayTitle.trim()) {
			cancel();
			return;
		}
		saveSeq.current += 1;
		const seq = saveSeq.current;
		setSaving(true);
		let ok = false;
		try {
			ok = await persistUpdateTask(task.id, { title: next });
		} catch {
			ok = false;
		} finally {
			// Toujours rendu au champ : un enregistrement refusé ne doit pas
			// laisser un titre gelé en lecture seule — mais seulement par le
			// dernier enregistrement lancé.
			if (saveSeq.current === seq) setSaving(false);
		}
		const stillShown = saveSeq.current === seq;
		if (ok) {
			if (stillShown) setEditing(false);
			return;
		}
		toast({
			title: t("tasks:inlineEdit.saveErrorTitle"),
			description: t("tasks:inlineEdit.titleSaveError"),
			variant: "destructive",
		});
		if (!stillShown) return;
		settled.current = false;
		input.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void commit();
		} else if (event.key === "Escape") {
			// Échap ferme aussi le dialogue : on n'annule que l'édition.
			event.preventDefault();
			event.stopPropagation();
			cancel();
		}
	};

	if (editing) {
		return (
			<>
				<Title className="sr-only">{displayTitle}</Title>
				<input
					ref={input}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={onKeyDown}
					onBlur={() => void commit()}
					disabled={saving}
					aria-label={t("tasks:inlineEdit.titleLabel")}
					className={cn(
						"-mx-2 -my-1 w-[calc(100%+1rem)] rounded-md border border-primary/50 bg-background px-2 py-1",
						"text-xl font-semibold leading-tight text-foreground outline-none ring-2 ring-primary/20",
						"disabled:opacity-60",
					)}
				/>
			</>
		);
	}

	return (
		<Title className={cn("min-w-0", className)}>
			{editable ? (
				<button
					type="button"
					onClick={open}
					title={t("tasks:inlineEdit.titleHint")}
					className={cn(
						"group -mx-2 -my-1 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left",
						"transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					<span className="truncate">{displayTitle}</span>
					<Pencil
						className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
						aria-hidden
					/>
				</button>
			) : (
				<span className="block truncate">{displayTitle}</span>
			)}
		</Title>
	);
}
