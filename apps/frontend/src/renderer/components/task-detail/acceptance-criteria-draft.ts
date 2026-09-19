/**
 * Le brouillon d'une liste de critères d'acceptation.
 *
 * Les critères sont stockés comme `string[]` dans `TaskMetadata.acceptanceCriteria`
 * et ils l'étaient aussi *pendant l'édition*, sous la forme d'un seul texte à
 * découper sur les retours à la ligne. Ce qui se perd dans ce format, ce n'est
 * pas le contenu — c'est l'identité : la troisième ligne d'un textarea n'a pas
 * d'existence propre, donc rien ne peut lui donner le focus, la supprimer ou la
 * déplacer. Un brouillon porte donc un `id` stable, indépendant du texte et de
 * la position, qui sert de clé React et de cible de focus tant que la ligne
 * existe.
 *
 * Tout ce qui n'a pas besoin de React vit ici : le composant s'occupe du focus
 * et du rendu, ces fonctions répondent au reste.
 */

export interface CriterionDraft {
	readonly id: string;
	readonly text: string;
}

let sequence = 0;

/** Un id unique pour la session. Jamais dérivé du texte : deux critères
 * identiques sont deux lignes distinctes, et un id qui change quand on tape
 * fait perdre le focus à chaque frappe. */
export function createDraft(text = ""): CriterionDraft {
	sequence += 1;
	return { id: `ac-${sequence}`, text };
}

/**
 * Le marqueur de puce qu'on retire d'une ligne saisie ou collée.
 *
 * Plus strict que le `^\s*[-*•\d.)\]]+\s*` que la lecture des trackers
 * utilise : là-bas la ligne vient d'un `<li>` et le marqueur est certain ;
 * ici elle vient de l'utilisateur, et « 3 tentatives maximum » n'est pas une
 * liste numérotée. Un chiffre ne compte que suivi d'un point ou d'une
 * parenthèse, et un marqueur doit être suivi d'une espace.
 */
const LEADING_BULLET = /^\s*(?:[-*•‣▪–—]|\d+[.)])\s+/;

export function stripBulletMarker(line: string): string {
	return line.replace(LEADING_BULLET, "").trim();
}

/** Les critères enregistrés → des lignes éditables. */
export function toDrafts(criteria: readonly string[]): CriterionDraft[] {
	return criteria.map((text) => createDraft(text));
}

/**
 * Les lignes éditables → ce qui est enregistré.
 *
 * Une ligne vide est une ligne qu'on vient d'ajouter et qu'on n'a pas encore
 * remplie : elle existe dans l'éditeur, elle n'a rien à faire sur le disque.
 */
export function toCriteria(drafts: readonly CriterionDraft[]): string[] {
	return drafts
		.map((draft) => stripBulletMarker(collapseNewlines(draft.text)))
		.filter((text) => text.length > 0);
}

/**
 * Un critère tient sur une ligne, parce que c'est une chaîne du tableau et
 * que tout ce qui le relit découpe sur les retours à la ligne. L'éditeur
 * refuse la touche Entrée, mais un glisser-déposer de texte dans un champ ne
 * passe par aucune touche : la garantie se prend donc à l'enregistrement.
 */
function collapseNewlines(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ");
}

/** Le texte du mode texte : ce qui est affiché, pas ce qui serait enregistré,
 * pour qu'une ligne en cours de saisie survive au changement de mode. */
export function draftsToText(drafts: readonly CriterionDraft[]): string {
	return drafts.map((draft) => draft.text).join("\n");
}

/** Le mode texte → des lignes. L'inverse de `draftsToText`, aux lignes vides
 * près : elles n'ont pas d'identité à conserver. */
export function textToDrafts(text: string): CriterionDraft[] {
	return splitPastedCriteria(text).map((line) => createDraft(line));
}

/**
 * Un bloc collé → une ligne par critère.
 *
 * Ne touche pas au HTML, contrairement à `parseAcceptanceCriteriaText` : ce
 * qui arrive ici est ce que l'utilisateur a dans son presse-papier, et un
 * critère « temps de réponse < 200ms > seuil » y est du texte, pas une balise.
 */
export function splitPastedCriteria(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(stripBulletMarker)
		.filter((line) => line.length > 0);
}

export function updateAt(
	drafts: readonly CriterionDraft[],
	index: number,
	text: string,
): CriterionDraft[] {
	if (index < 0 || index >= drafts.length) return [...drafts];
	return drafts.map((draft, i) => (i === index ? { ...draft, text } : draft));
}

export function insertAt(
	drafts: readonly CriterionDraft[],
	index: number,
	inserted: readonly CriterionDraft[],
): CriterionDraft[] {
	const at = Math.max(0, Math.min(index, drafts.length));
	return [...drafts.slice(0, at), ...inserted, ...drafts.slice(at)];
}

export function removeAt(
	drafts: readonly CriterionDraft[],
	index: number,
): CriterionDraft[] {
	if (index < 0 || index >= drafts.length) return [...drafts];
	return drafts.filter((_, i) => i !== index);
}

/** Déplace une ligne. Hors bornes, la liste est rendue telle quelle : une
 * flèche vers le haut sur la première ligne ne doit rien faire, pas la faire
 * passer à la fin. */
export function moveItem(
	drafts: readonly CriterionDraft[],
	from: number,
	to: number,
): CriterionDraft[] {
	if (from < 0 || from >= drafts.length) return [...drafts];
	if (to < 0 || to >= drafts.length) return [...drafts];
	const next = [...drafts];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** L'éditeur affiche toujours au moins une ligne : une liste vide n'offre
 * nulle part où taper, et « cliquez pour ajouter » sans champ est une impasse. */
export function ensureAtLeastOne(
	drafts: readonly CriterionDraft[],
): CriterionDraft[] {
	return drafts.length > 0 ? [...drafts] : [createDraft()];
}

export function sameCriteria(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}
