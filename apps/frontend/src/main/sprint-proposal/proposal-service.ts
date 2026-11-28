/**
 * « Proposer le sprint »: the rules rank the backlog (`proposal-rules.ts`),
 * then the person's model, whichever provider it is (`runOneShotLLM`),
 * composes the sprint among the best ranked cards and says why, in the app's
 * language. The rules check what it chose: a card is named only by a
 * reference this code gave, joins after what it waits on, and only while the
 * capacity holds. Without a usable answer the rules' own proposal stands.
 *
 * What the model reads (GDPR): a card's title, the start of its
 * description, its priority, type, points, labels and dependencies, all as
 * quoted data (S2). Never who works on it, nor any other field.
 *
 * Design: docs/architecture/sprint-proposal.md.
 */

import type { SprintProposal, SprintProposalVariant } from "../../shared/types";
import { SPRINT_PROPOSAL_LIMITS } from "../../shared/types/sprint-proposal";
import { taskLabels } from "../../shared/utils/task-labels";
import { type CompletionFn, jsonObject, LANGUAGE_NAMES, oneLine, SYSTEM_PROMPT } from "../board-ask/board-ask-service";
import { quoteUntrusted, untrustedLine } from "../security/untrusted-text";
import { type Candidate, fill, proposeByRules, type RuleInput, rankCandidates, targetPoints } from "./proposal-rules";

export interface ProposeSprintInput extends RuleInput {
	/** Points already in the sprint. */
	committed: number;
	appLanguage: string;
	/** The person's model; absent, the rules answer alone. */
	complete?: CompletionFn;
}

const VARIANT_GUIDANCE: Record<SprintProposalVariant, string> = {
	balanced: "Balance urgency, bugs, what unblocks other cards and the sprint goal.",
	careful: "Be careful: prefer cards that are well understood and leave the sprint some margin.",
	bugs: "Favour bug fixes: the team wants to pay down defects this sprint.",
	goal: "Compose the sprint around its goal: leave out cards unrelated to it, even when room remains.",
};

/** HTML tags and runs of blanks out of a description, its start kept. */
function descriptionStart(text: string | undefined): string {
	const plain = (text ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > SPRINT_PROPOSAL_LIMITS.description
		? `${plain.slice(0, SPRINT_PROPOSAL_LIMITS.description - 1)}…`
		: plain;
}

/** One card as the model reads it, its blockers named by their reference. */
function cardLine(candidate: Candidate, ref: string, refOf: ReadonlyMap<string, string>): string {
	const { task } = candidate;
	const parts = [`${ref}`, `${candidate.points} pts`];
	parts.push(`priority ${task.metadata?.priority ?? "none"}`);
	if (task.metadata?.category) parts.push(`type ${task.metadata.category}`);
	const waits = candidate.waitsOn.map((id) => refOf.get(id) ?? "a card not listed");
	if (waits.length > 0) parts.push(`waits on ${waits.join(", ")}`);
	if (candidate.unblocks > 0) parts.push(`unblocks ${candidate.unblocks}`);
	const labels = taskLabels(task);
	if (labels.length > 0) parts.push(`labels ${labels.map((label) => untrustedLine(label, 40)).join(", ")}`);
	const description = descriptionStart(task.description);
	const title = untrustedLine(task.title, 160);
	return `${parts.join(" | ")} | ${title}${description ? ` — ${description}` : ""}`;
}

export function buildProposalPrompt(
	listed: readonly Candidate[],
	options: { room: number; committed: number; variant: SprintProposalVariant; goal?: string; appLanguage: string },
): string {
	const refOf = new Map(listed.map((candidate, index) => [candidate.task.id, `c${index + 1}`]));
	const language = LANGUAGE_NAMES[options.appLanguage] ?? "English";
	const cards = listed.map((candidate) => cardLine(candidate, refOf.get(candidate.task.id) as string, refOf)).join("\n");
	const goal = options.goal?.trim()
		? quoteUntrusted("The sprint goal", options.goal.slice(0, SPRINT_PROPOSAL_LIMITS.goal))
		: "The sprint has no goal yet: offer one, a single short sentence, that the cards you pick serve.";
	return [
		"You plan the next sprint of a software team from its backlog.",
		`The sprint already holds ${options.committed} points. Pick cards worth at most ${options.room} more points, in total.`,
		"Points are the team's own estimate of effort. Never speak of hours or days.",
		VARIANT_GUIDANCE[options.variant],
		"A card that waits on another card can only be done after it: pick its blocker too, or leave it out.",
		"Cards are listed best ranked first by priority, type, age and what they unblock; you may reorder.",
		goal,
		quoteUntrusted("The backlog cards, one per line (ref | points | facts | title — description)", cards),
		"Answer with JSON only:",
		'{"picks":[{"ref":"c1","reason":"why this card, at most 12 words"}],"goal":"…","summary":"…"}',
		`- "picks": the cards to propose, in the order to read them, each named by its ref.`,
		`- "goal": ${options.goal?.trim() ? "an empty string." : "the goal you offer."}`,
		`- "summary": two or three sentences on the choice as a whole.`,
		`Write every reason, the goal and the summary in ${language}.`,
	].join("\n\n");
}

interface ModelChoice {
	order: string[];
	notes: Map<string, string>;
	goal: string;
	summary: string;
}

/** The model's answer read into known cards and bounded text, or null when nothing usable came back. */
export function parseProposal(raw: string | null, idOf: ReadonlyMap<string, string>): ModelChoice | null {
	if (!raw) return null;
	const json = jsonObject(raw);
	if (!json || !Array.isArray(json.picks)) return null;
	const order: string[] = [];
	const notes = new Map<string, string>();
	for (const item of json.picks) {
		if (typeof item !== "object" || item === null) continue;
		const { ref, reason } = item as Record<string, unknown>;
		const id = typeof ref === "string" ? idOf.get(ref.trim()) : undefined;
		if (!id || order.includes(id)) continue;
		order.push(id);
		const note = oneLine(reason, SPRINT_PROPOSAL_LIMITS.note);
		if (note) notes.set(id, note);
	}
	if (order.length === 0) return null;
	return {
		order,
		notes,
		goal: oneLine(json.goal, SPRINT_PROPOSAL_LIMITS.goal),
		summary: oneLine(json.summary, SPRINT_PROPOSAL_LIMITS.summary),
	};
}

/** The proposal for a sprint: the model's when it answers usably, the rules' otherwise. */
export async function proposeSprint(input: ProposeSprintInput): Promise<SprintProposal> {
	const rules = proposeByRules(input, input.committed);
	if (!input.complete) return rules;
	const pool = rankCandidates(input);
	const listed = pool.candidates.slice(0, SPRINT_PROPOSAL_LIMITS.candidates);
	const room = Math.max(0, targetPoints(input.capacity, input.variant) - input.committed);
	if (listed.length === 0 || room === 0) return rules;

	const prompt = buildProposalPrompt(listed, {
		room,
		committed: input.committed,
		variant: input.variant,
		goal: input.goal,
		appLanguage: input.appLanguage,
	});
	let raw: string | null;
	try {
		raw = await input.complete(prompt, SYSTEM_PROMPT, "sprint-proposal");
	} catch {
		raw = null;
	}
	const idOf = new Map(listed.map((candidate, index) => [`c${index + 1}`, candidate.task.id]));
	const choice = parseProposal(raw, idOf);
	if (!choice) return rules;

	const ranked = pool.candidates.map((candidate) => candidate.task.id);
	const filled = fill(choice.order, pool.candidates, room, input.committed, choice.notes, ranked);
	if (filled.picks.length === 0) return rules;
	const proposal: SprintProposal = {
		...rules,
		picks: filled.picks,
		points: filled.points,
		below: filled.below,
		mode: "ai",
	};
	if (choice.summary) proposal.summary = choice.summary;
	if (choice.goal && !input.goal?.trim()) proposal.goal = choice.goal;
	return proposal;
}
