/**
 * The card « Vérifier une idée » offers to create: the idea's title, and a
 * description that holds only what the board does not already do. A
 * requirement already done stays out; one done in part keeps the tickets it
 * builds on, so whoever takes the card starts from them.
 */

import type { BoardIdeaResult, BoardIdeaVerdict } from "../../../../shared/types";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const SECTIONS: readonly Exclude<BoardIdeaVerdict, "done">[] = ["missing", "partial", "unknown"];
const MAX_TITLE_CHARS = 120;

/** Whether some requirement is still to build or to check. */
export function hasWorkLeft(result: BoardIdeaResult): boolean {
	return result.requirements.some((r) => r.verdict !== "done");
}

export function ideaCard(result: BoardIdeaResult, idea: string, t: Translate): { title: string; description: string } {
	const title = (result.title || idea.split(/\r?\n/)[0] || t("kanban.ask.idea.card.untitled"))
		.trim()
		.slice(0, MAX_TITLE_CHARS);
	const lines: string[] = [];
	if (result.summary) lines.push(result.summary, "");
	for (const verdict of SECTIONS) {
		const requirements = result.requirements.filter((r) => r.verdict === verdict);
		if (requirements.length === 0) continue;
		lines.push(`## ${t(`kanban.ask.idea.card.section.${verdict}`)}`, "");
		for (const requirement of requirements) {
			lines.push(`- ${requirement.reason ? `${requirement.text} (${requirement.reason})` : requirement.text}`);
			if (verdict === "partial" && requirement.matches.length > 0) {
				const tickets = requirement.matches.map((m) => m.title).join(", ");
				lines.push(`  - ${t("kanban.ask.idea.card.buildsOn", { tickets })}`);
			}
		}
		lines.push("");
	}
	const done = result.requirements.filter((r) => r.verdict === "done");
	if (done.length > 0) {
		lines.push(`## ${t("kanban.ask.idea.card.section.done")}`, "");
		for (const requirement of done) {
			const tickets = requirement.matches.map((m) => m.title).join(", ");
			lines.push(`- ${tickets ? `${requirement.text} → ${tickets}` : requirement.text}`);
		}
		lines.push("");
	}
	lines.push(`## ${t("kanban.ask.idea.card.original")}`, "", idea.trim());
	return { title, description: lines.join("\n").trim() };
}
