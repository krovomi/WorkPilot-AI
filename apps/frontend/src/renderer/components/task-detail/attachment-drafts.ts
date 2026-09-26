/**
 * Les règles, sans React, du panneau des propositions tirées des pièces jointes.
 *
 * Trois questions, chacune avec une seule réponse :
 * - faut-il proposer de lire les pièces jointes maintenant ?
 * - qu'est-ce qui attend encore une décision ?
 * - comment des critères acceptés rejoignent-ils ceux de la tâche ?
 */

import type {
	CriterionDraft,
	DocintelDraftsPayload,
	RequirementDraft,
	RuleTableDraft,
} from "../../lib/agent-tools-api";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

/**
 * Proposer « Lire les pièces jointes » quand rien n'a encore été lu et qu'une
 * pièce jointe peut porter un cahier des charges : un PDF ou un texte. Une
 * capture d'écran de maquette n'en porte pas — le build la lira quand même,
 * mais un bouton sur chaque tâche qui a une capture serait du bruit.
 */
export function offersExtraction(payload: DocintelDraftsPayload | null): boolean {
	if (!payload || payload.drafts) return false;
	return payload.readable.some((path) => !IMAGE.test(path));
}

export function pendingRequirements(
	payload: DocintelDraftsPayload | null,
): RequirementDraft[] {
	return payload?.drafts?.requirements.filter((r) => r.status === "proposed") ?? [];
}

export function pendingCriteria(
	payload: DocintelDraftsPayload | null,
): CriterionDraft[] {
	return payload?.drafts?.criteria.filter((c) => c.status === "proposed") ?? [];
}

/** Les tableaux de règles que les agents recevront : tous sauf les écartés. */
export function activeTables(payload: DocintelDraftsPayload | null): RuleTableDraft[] {
	return payload?.drafts?.tables.filter((t) => t.status !== "rejected") ?? [];
}

function normalise(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Les critères de la tâche, plus ceux qu'on vient d'accepter — une fois chacun.
 * L'ordre existant est gardé : c'est celui que la personne a choisi dans
 * l'éditeur en puces.
 */
export function mergeCriteria(existing: string[], added: string[]): string[] {
	const seen = new Set(existing.map(normalise));
	const merged = [...existing];
	for (const criterion of added) {
		const key = normalise(criterion);
		if (key && !seen.has(key)) {
			seen.add(key);
			merged.push(criterion.trim());
		}
	}
	return merged;
}

/** `cahier.pdf, p. 3, EF-01` — d'où vient une proposition (page traduite). */
export function sourceLabel(
	draft: { source: string; page: number; ref?: string },
	pageLabel: (page: number) => string,
): string {
	const parts = [draft.source.split("/").pop() ?? draft.source];
	if (draft.page) parts.push(pageLabel(draft.page));
	if (draft.ref) parts.push(draft.ref);
	return parts.join(", ");
}
