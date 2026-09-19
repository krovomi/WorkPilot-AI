import { Plus, X } from "lucide-react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
	type CriterionDraft,
	createDraft,
	ensureAtLeastOne,
	insertAt,
	moveItem,
	removeAt,
	splitPastedCriteria,
	updateAt,
} from "./acceptance-criteria-draft";

interface AcceptanceCriteriaEditorProps {
	readonly drafts: readonly CriterionDraft[];
	readonly onChange: (next: CriterionDraft[]) => void;
	readonly disabled?: boolean;
}

/** Où poser le focus après un rendu que l'utilisateur vient de provoquer —
 * la ligne ajoutée, celle qui reste après une suppression, celle qui a bougé.
 * Sans ça, ajouter une puce oblige à aller la cliquer. */
interface PendingFocus {
	readonly id: string;
	readonly caret: "start" | "end";
}

/**
 * L'éditeur en puces des critères d'acceptation.
 *
 * Il remplace un textarea où chaque ligne était un critère — format qui lit
 * bien et s'édite mal : une ligne n'y est pas une chose, donc la supprimer,
 * la déplacer ou savoir combien il y en a sont trois opérations sur du texte.
 * Ici chaque critère est une ligne à part entière, et le mode texte reste
 * offert à côté pour les retouches en masse (coller dix critères, en
 * réordonner la moitié).
 */
export function AcceptanceCriteriaEditor({
	drafts,
	onChange,
	disabled = false,
}: AcceptanceCriteriaEditorProps) {
	const { t } = useTranslation(["tasks"]);
	// Un textarea par ligne, adressé par id : l'index bouge à chaque insertion
	// et le focus suivrait alors la position plutôt que la ligne.
	const inputs = useRef(new Map<string, HTMLTextAreaElement>());
	const pendingFocus = useRef<PendingFocus | null>(null);

	const registerInput = useCallback(
		(id: string, element: HTMLTextAreaElement | null) => {
			if (element) inputs.current.set(id, element);
			else inputs.current.delete(id);
		},
		[],
	);

	const focusInput = useCallback((id: string, caret: "start" | "end") => {
		const element = inputs.current.get(id);
		if (!element) return;
		element.focus();
		const at = caret === "start" ? 0 : element.value.length;
		element.setSelectionRange(at, at);
	}, []);

	// `drafts` est ici le signal du rendu qui vient d'ajouter ou de supprimer la
	// ligne, pas une valeur lue — c'est après ce rendu-là que le focus se pose.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voir ci-dessus.
	useEffect(() => {
		const target = pendingFocus.current;
		if (!target) return;
		pendingFocus.current = null;
		focusInput(target.id, target.caret);
	}, [drafts, focusInput]);

	const commit = (next: CriterionDraft[], focus?: PendingFocus) => {
		if (focus) pendingFocus.current = focus;
		onChange(next);
	};

	const addAfter = (index: number) => {
		const fresh = createDraft();
		commit(insertAt(drafts, index + 1, [fresh]), {
			id: fresh.id,
			caret: "end",
		});
	};

	const remove = (index: number) => {
		// Supprimer la dernière puce laisse une puce vide, pas un vide : une
		// liste sans champ n'offre nulle part où taper, et la ligne vide ne
		// part pas à l'enregistrement — effacer tout reste donc possible.
		const next = ensureAtLeastOne(removeAt(drafts, index));
		// On remonte sur la ligne précédente, ou à défaut sur celle qui a pris
		// la place de la supprimée.
		const neighbour = next[index - 1] ?? next[index];
		commit(next, neighbour ? { id: neighbour.id, caret: "end" } : undefined);
	};

	const move = (from: number, to: number) => {
		if (to < 0 || to >= drafts.length) return;
		commit(moveItem(drafts, from, to), {
			id: drafts[from].id,
			caret: "end",
		});
	};

	const handleKeyDown = (
		event: KeyboardEvent<HTMLTextAreaElement>,
		index: number,
	) => {
		const element = event.currentTarget;

		if (event.key === "Enter") {
			// Un critère est une chaîne du tableau : un retour à la ligne à
			// l'intérieur serait un critère que rien ne sait relire.
			event.preventDefault();
			addAfter(index);
			return;
		}

		if (
			event.key === "Backspace" &&
			element.selectionStart === 0 &&
			element.selectionEnd === 0 &&
			element.value.length === 0 &&
			drafts.length > 1
		) {
			event.preventDefault();
			remove(index);
			return;
		}

		if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			move(index, event.key === "ArrowUp" ? index - 1 : index + 1);
			return;
		}

		// Les flèches traversent les puces comme elles traverseraient les lignes
		// d'un textarea : aux bords seulement, pour que déplacer le curseur à
		// l'intérieur d'un critère long reste possible.
		if (event.key === "ArrowUp" && element.selectionStart === 0) {
			const previous = drafts[index - 1];
			if (!previous) return;
			event.preventDefault();
			focusInput(previous.id, "end");
			return;
		}

		if (
			event.key === "ArrowDown" &&
			element.selectionStart === element.value.length
		) {
			const next = drafts[index + 1];
			if (!next) return;
			event.preventDefault();
			focusInput(next.id, "start");
		}
	};

	/**
	 * Coller un bloc de plusieurs lignes crée une puce par ligne.
	 *
	 * C'est le geste par lequel arrive la plupart des critères — copiés d'un
	 * ticket, d'une spec, d'un message. Sans ce découpage, le mode puces serait
	 * le mode où l'on ne peut pas coller ce qu'on a sous la main.
	 */
	const handlePaste = (
		event: ClipboardEvent<HTMLTextAreaElement>,
		index: number,
	) => {
		const pasted = event.clipboardData.getData("text/plain");
		// Un collage d'une seule ligne reste celui du navigateur : son curseur
		// et son annulation valent mieux que ce qu'on referait à la main.
		if (!pasted.includes("\n")) return;

		// À partir d'ici le collage est le nôtre, même s'il ne reste rien à
		// coller : laisser passer un bloc de lignes vides écrirait un retour à
		// la ligne dans un critère, et un critère n'a qu'une ligne.
		event.preventDefault();
		const parts = splitPastedCriteria(pasted);
		if (parts.length === 0) return;

		const element = event.currentTarget;
		const before = element.value.slice(0, element.selectionStart);
		const after = element.value.slice(element.selectionEnd);

		const first = `${before}${parts[0]}`;
		const rest = parts.slice(1);
		const lastText = `${rest[rest.length - 1] ?? first}${after}`;

		if (rest.length === 0) {
			commit(updateAt(drafts, index, `${first}${after}`), {
				id: drafts[index].id,
				caret: "end",
			});
			return;
		}

		const inserted = rest.map((text, i) =>
			createDraft(i === rest.length - 1 ? lastText : text),
		);
		commit(insertAt(updateAt(drafts, index, first), index + 1, inserted), {
			id: inserted[inserted.length - 1].id,
			caret: "end",
		});
	};

	return (
		<div className="space-y-1.5">
			<ul className="space-y-1" aria-label={t("tasks:metadata.acListLabel")}>
				{drafts.map((draft, index) => (
					<li key={draft.id} className="group flex items-start gap-2">
						<span
							aria-hidden="true"
							className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
						/>
						<CriterionInput
							draft={draft}
							index={index}
							disabled={disabled}
							register={registerInput}
							onChange={(text) => commit(updateAt(drafts, index, text))}
							onKeyDown={handleKeyDown}
							onPaste={handlePaste}
						/>
						<button
							type="button"
							disabled={disabled}
							onClick={() => remove(index)}
							aria-label={t("tasks:metadata.acRemove", {
								index: index + 1,
							})}
							className={cn(
								"mt-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity",
								"hover:bg-muted hover:text-foreground focus-visible:opacity-100",
								"group-hover:opacity-100 group-focus-within:opacity-100",
								"disabled:cursor-not-allowed disabled:opacity-0",
							)}
						>
							<X className="h-3 w-3" />
						</button>
					</li>
				))}
			</ul>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				disabled={disabled}
				onClick={() => addAfter(drafts.length - 1)}
				className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
			>
				<Plus className="h-3 w-3" />
				{t("tasks:metadata.acAdd")}
			</Button>
		</div>
	);
}

interface CriterionInputProps {
	readonly draft: CriterionDraft;
	readonly index: number;
	readonly disabled: boolean;
	readonly register: (id: string, element: HTMLTextAreaElement | null) => void;
	readonly onChange: (text: string) => void;
	readonly onKeyDown: (
		event: KeyboardEvent<HTMLTextAreaElement>,
		index: number,
	) => void;
	readonly onPaste: (
		event: ClipboardEvent<HTMLTextAreaElement>,
		index: number,
	) => void;
}

function CriterionInput({
	draft,
	index,
	disabled,
	register,
	onChange,
	onKeyDown,
	onPaste,
}: CriterionInputProps) {
	const { t } = useTranslation(["tasks"]);
	const ref = useRef<HTMLTextAreaElement | null>(null);

	// Une puce fait la hauteur de son texte : un critère Gherkin dépasse la
	// largeur du panneau, et une barre de défilement dans une ligne de liste
	// cache la fin de la phrase qu'on est en train d'écrire. Le texte est la
	// raison de recalculer, même si la mesure se lit sur le DOM.
	// biome-ignore lint/correctness/useExhaustiveDependencies: voir ci-dessus.
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;
	}, [draft.text]);

	return (
		<Textarea
			ref={(element) => {
				ref.current = element;
				register(draft.id, element);
			}}
			rows={1}
			value={draft.text}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
			onKeyDown={(event) => onKeyDown(event, index)}
			onPaste={(event) => onPaste(event, index)}
			placeholder={t("tasks:metadata.acItemPlaceholder")}
			aria-label={t("tasks:metadata.acItemLabel", { index: index + 1 })}
			className="min-h-0 flex-1 resize-none overflow-hidden rounded-md px-2 py-1 text-sm leading-relaxed"
		/>
	);
}
