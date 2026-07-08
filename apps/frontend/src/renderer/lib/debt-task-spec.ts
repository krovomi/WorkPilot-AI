/**
 * Turn a scored tech-debt item into a Kanban task spec (title + description).
 *
 * Pure & bilingual so the resulting task reads well for the human reviewer AND
 * gives the agentic pipeline enough context to plan a fix. Mirrors the backend
 * `generate_spec_from_item` markdown, but produces the description the task's
 * own spec is built from — no orphan spec folder.
 */

import type { DebtItem } from "../../preload/api/modules/tech-debt-api";

export type Lang = "fr" | "en";

const KIND_LABELS: Record<Lang, Record<string, string>> = {
	fr: {
		todo_fixme: "TODO/FIXME",
		long_function: "Fonction trop longue",
		deep_complexity: "Imbrication profonde",
		duplication: "Duplication",
		stale_deps: "Dépendances obsolètes",
		low_coverage: "Faible couverture",
	},
	en: {
		todo_fixme: "TODO/FIXME",
		long_function: "Long function",
		deep_complexity: "Deep nesting",
		duplication: "Duplication",
		stale_deps: "Stale deps",
		low_coverage: "Low coverage",
	},
};

function kindLabel(kind: string, lang: Lang): string {
	return KIND_LABELS[lang][kind] ?? kind;
}

/** Collapse the (sometimes long) debt message into a one-line task title. */
function buildTitle(item: DebtItem, lang: Lang): string {
	const message = item.message.trim().replace(/\s+/g, " ");
	const short = message.length > 80 ? `${message.slice(0, 77)}…` : message;
	const prefix =
		lang === "fr" ? "Dette technique" : "Tech debt";
	return `${prefix} : ${short}`;
}

export interface DebtTaskSpec {
	title: string;
	description: string;
	/**
	 * Surfaced through `metadata.acceptanceCriteria` so they land in the task's
	 * dedicated AC panel — the scanner strips any "Acceptance criteria" section
	 * out of the description body, so keeping them there too would drop them.
	 */
	acceptanceCriteria: string[];
}

/**
 * Build the `{ title, description, acceptanceCriteria }` handed to `createTask`
 * for a debt item.
 */
export function buildDebtTaskSpec(item: DebtItem, lang: Lang): DebtTaskSpec {
	const title = buildTitle(item, lang);
	const location = `${item.file_path}:${item.line}`;
	const tags = item.tags.length ? item.tags.join(", ") : "—";

	const lines: string[] =
		lang === "fr"
			? [
					`## Dette technique détectée`,
					"",
					item.message.trim(),
					"",
					"### Signal source",
					"",
					`- Emplacement : \`${location}\``,
					`- Type : **${kindLabel(item.kind, lang)}**`,
					`- Coût (par semaine si conservé) : **${item.cost}**`,
					`- Effort de correction (h) : **${item.effort}**`,
					`- ROI : **${item.roi}**`,
					`- Tags : ${tags}`,
				]
			: [
					`## Detected tech debt`,
					"",
					item.message.trim(),
					"",
					"### Source signal",
					"",
					`- Location: \`${location}\``,
					`- Kind: **${kindLabel(item.kind, lang)}**`,
					`- Cost (per week if kept): **${item.cost}**`,
					`- Effort to fix (h): **${item.effort}**`,
					`- ROI: **${item.roi}**`,
					`- Tags: ${tags}`,
				];

	if (item.context.trim()) {
		lines.push(
			"",
			lang === "fr" ? "### Contexte" : "### Context",
			"",
			"```",
			item.context.trim(),
			"```",
		);
	}

	lines.push(
		"",
		lang === "fr" ? "### Objectif" : "### Objective",
		"",
		lang === "fr"
			? `Résoudre la dette technique détectée dans \`${location}\`.`
			: `Resolve the tech debt detected in \`${location}\`.`,
	);

	const acceptanceCriteria =
		lang === "fr"
			? [
					"L'élément n'apparaît plus au prochain scan de dette technique.",
					"Les tests existants passent toujours.",
					"De nouveaux tests couvrent le code refactoré si le comportement change.",
				]
			: [
					"The item no longer appears in the next tech debt scan.",
					"Existing tests still pass.",
					"New tests cover the refactored path when behaviour changes.",
				];

	return { title, description: lines.join("\n"), acceptanceCriteria };
}
