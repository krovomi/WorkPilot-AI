/**
 * « Vérifier une idée » (docs/architecture/board-ask.md, lot 3): a product
 * owner pastes a feature they plan; the board says, requirement by
 * requirement, what its tickets already do, in part or in full, and what is
 * still missing, whatever language either is written in.
 *
 * 1. **Split.** The model of the chosen provider splits the idea into the
 *    requirements one could check one by one, and names it; without a model,
 *    its lines or sentences are the requirements.
 * 2. **Search.** Each requirement is searched like a question
 *    (`board-ask-service.ts`): keywords, and its meaning when an embeddings
 *    model can be asked (one runner call for all of them), fused.
 * 3. **Judge.** The model reads the requirements and the union of their
 *    candidates and says, for each requirement, `done`, `partial` or
 *    `missing`, with the tickets that hold it and one line why.
 *
 * Without a judgement, each requirement lists its closest tickets as
 * `unknown`. The idea and the tickets enter the prompts quoted (S2); the
 * model names requirements and tickets only by the references this code gave.
 */

import type {
	BoardAskMatch,
	BoardIdeaRequirement,
	BoardIdeaResult,
	BoardIdeaVerdict,
	Task,
} from "../../shared/types";
import { BOARD_ASK_LIMITS } from "../../shared/types/board-ask";
import { KeywordIndex } from "../../shared/utils/board-ask-search";
import { quoteUntrusted } from "../security/untrusted-text";
import {
	type CompletionFn,
	closest,
	fuseRanks,
	jsonObject,
	LANGUAGE_NAMES,
	oneLine,
	SEMANTIC_BAND,
	SYSTEM_PROMPT,
	semanticInfo,
	toMatch,
} from "./board-ask-service";
import type { SemanticManyFn, SemanticRanking } from "./semantic-search";
import { type BoardTicket, boardTickets, ticketDigest, ticketDocument, ticketMeaning } from "./tickets";

/** Candidates read per requirement. */
export const PER_REQUIREMENT = 8;
/** Tickets the model reads in all. */
export const MAX_IDEA_CANDIDATES = 40;
/** Tickets kept on a requirement. */
const MATCHES_PER_REQUIREMENT = 5;
/** Tickets listed on a requirement no model judged. */
const UNJUDGED_MATCHES = 3;
const MAX_REQUIREMENT_CHARS = 300;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 2000;
const MAX_REASON_CHARS = 300;
const DIGEST_CHARS = 700;
const MIN_REQUIREMENT_CHARS = 8;

export interface CheckIdeaInput {
	tasks: readonly Task[];
	idea: string;
	appLanguage: string;
	complete: CompletionFn;
	readSpec?: (task: Task) => string;
	/** The roadmap's features, the ideas and the merged changes (`sources.ts`). */
	sources?: readonly BoardTicket[];
	semantic?: SemanticManyFn;
}

interface Split {
	title: string;
	requirements: string[];
}

interface JudgedRequirement {
	verdict: Exclude<BoardIdeaVerdict, "unknown">;
	tickets: string[];
	reason: string;
}

const JUDGED_VERDICTS = ["done", "partial", "missing"] as const;

export function buildSplitPrompt(idea: string): string {
	return [
		"A product owner describes a feature they plan for a software product. Split it into the",
		"requirements one could check one by one against the tickets already done: each one short, concrete",
		`and verifiable (a screen, a behaviour, a rule, an export...). At most ${BOARD_ASK_LIMITS.requirements} requirements, each under`,
		"25 words, in the order of the description. Then give the feature a short title (at most 10 words).",
		"Write the title and the requirements in the language of the description.",
		"",
		'Output ONLY a JSON object: {"title": "...", "requirements": ["...", "..."]}',
		"",
		quoteUntrusted("Feature", idea),
	].join("\n");
}

export function parseSplit(raw: string | null): Split | null {
	if (!raw) return null;
	const parsed = jsonObject(raw);
	if (!parsed) return null;
	const requirements = (Array.isArray(parsed.requirements) ? parsed.requirements : [])
		.map((r) => oneLine(r, MAX_REQUIREMENT_CHARS))
		.filter(Boolean);
	const unique = [...new Set(requirements)].slice(0, BOARD_ASK_LIMITS.requirements);
	if (unique.length === 0) return null;
	return { title: oneLine(parsed.title, MAX_TITLE_CHARS), requirements: unique };
}

/**
 * The idea's own lines (a list) or sentences as its requirements, and its
 * first line as title: what is checked when no model can split it.
 */
export function splitWithoutModel(idea: string): Split {
	const lines = idea
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const bullet = /^(?:[-*•]|\d+[.)])\s+/;
	const listed = lines.filter((line) => bullet.test(line)).map((line) => line.replace(bullet, ""));
	const parts =
		listed.length >= 2
			? listed
			: lines
					.map((line) => line.replace(bullet, ""))
					.join(" ")
					.split(/(?<=[.!?;。！？])\s+/)
					.map((part) => part.trim());
	const requirements = [
		...new Set(
			parts.map((p) => oneLine(p, MAX_REQUIREMENT_CHARS)).filter((p) => p.length >= MIN_REQUIREMENT_CHARS),
		),
	].slice(0, BOARD_ASK_LIMITS.requirements);
	const first = (lines[0] ?? "").replace(bullet, "");
	return {
		title: oneLine(first, MAX_TITLE_CHARS),
		requirements: requirements.length > 0 ? requirements : [oneLine(idea, MAX_REQUIREMENT_CHARS)],
	};
}

export function buildIdeaJudgePrompt(
	requirements: readonly { ref: string; text: string }[],
	candidates: readonly { ref: string; ticket: BoardTicket }[],
	appLanguage: string,
): string {
	const fallback = LANGUAGE_NAMES[appLanguage] ?? "English";
	const reqs = requirements.map((r) => `[${r.ref}] ${r.text}`).join("\n");
	const tickets = candidates.map(({ ref, ticket }) => `[${ref}]\n${ticketDigest(ticket, DIGEST_CHARS)}`).join("\n\n");
	return [
		"A product owner plans a feature and wants to know what the project's board already holds of it.",
		"For each requirement, read the tickets (they may be written in another language: judge by meaning)",
		"and give:",
		'- "verdict": "done" when finished tickets already deliver it, "partial" when they deliver part of',
		'  it or when it is only in progress, planned or abandoned, "missing" when no ticket holds it; a',
		"  roadmap feature or an idea (its Kind line) is only a plan, a merged change is delivered code;",
		'- "tickets": the references of the tickets that hold it or part of it, best first (none for missing);',
		'- "reason": one short sentence on what exists and what is left.',
		'Then write "summary": two or three sentences on what is already there and what a new card should',
		"still hold.",
		"",
		`Write "summary" and every "reason" in the language of the requirements; if it cannot be told, in ${fallback}.`,
		"Output ONLY a JSON object:",
		'{"summary": "...", "requirements": [{"ref": "R1", "verdict": "partial", "tickets": ["T2"], "reason": "..."}]}',
		"",
		quoteUntrusted("Requirements", reqs),
		"",
		quoteUntrusted("Tickets", tickets || "(none)"),
	].join("\n");
}

export function parseIdeaJudgement(
	raw: string | null,
	reqRefs: ReadonlySet<string>,
	ticketRefs: ReadonlySet<string>,
): { summary: string; requirements: Map<string, JudgedRequirement> } | null {
	if (!raw) return null;
	const parsed = jsonObject(raw);
	if (!parsed || !Array.isArray(parsed.requirements)) return null;
	const requirements = new Map<string, JudgedRequirement>();
	const strip = (value: unknown) => (typeof value === "string" ? value.trim().replace(/^\[|\]$/g, "") : "");
	for (const item of parsed.requirements) {
		if (typeof item !== "object" || item === null) continue;
		const { ref, verdict, tickets, reason } = item as Record<string, unknown>;
		const key = strip(ref);
		if (!reqRefs.has(key) || requirements.has(key)) continue;
		const level = JUDGED_VERDICTS.find((v) => v === verdict);
		if (!level) continue;
		const named = (Array.isArray(tickets) ? tickets : []).map(strip).filter((t) => ticketRefs.has(t));
		requirements.set(key, {
			verdict: level,
			tickets: level === "missing" ? [] : [...new Set(named)].slice(0, MATCHES_PER_REQUIREMENT),
			reason: oneLine(reason, MAX_REASON_CHARS),
		});
	}
	if (requirements.size === 0) return null;
	return { summary: oneLine(parsed.summary, MAX_SUMMARY_CHARS), requirements };
}

export async function checkIdea(input: CheckIdeaInput): Promise<BoardIdeaResult> {
	const idea = input.idea.trim().slice(0, BOARD_ASK_LIMITS.idea);
	const tickets = boardTickets(input.tasks, input.readSpec, input.sources);
	const split =
		parseSplit(idea ? await input.complete(buildSplitPrompt(idea), SYSTEM_PROMPT, "BoardIdeaSplit") : null) ??
		splitWithoutModel(idea);
	const empty = (mode: BoardIdeaResult["mode"]): BoardIdeaResult => ({
		title: split.title,
		summary: "",
		requirements: split.requirements.map((text) => ({ text, verdict: "unknown", matches: [] })),
		mode,
		searched: tickets.length,
	});
	if (!idea) return { ...empty("keywords"), requirements: [] };
	if (tickets.length === 0) return empty("keywords");

	const byId = new Map(tickets.map((t) => [t.id, t]));
	const index = new KeywordIndex(tickets.map(ticketDocument));
	const meanings: (SemanticRanking | null)[] =
		(input.semantic
			? await input
					.semantic(
						split.requirements,
						tickets.map((t) => ({ id: t.id, text: ticketMeaning(t) })),
					)
					.catch(() => null)
			: null) ?? [];
	const meaning = meanings.find((m): m is SemanticRanking => Boolean(m)) ?? null;

	const perRequirement = split.requirements.map((text, i) => {
		const keywords = index
			.search(
				[
					{ text, weight: 1 },
					{ text: split.title, weight: 0.3 },
				],
				PER_REQUIREMENT,
			)
			.map((hit) => hit.id);
		const ranking = meanings[i] ?? null;
		return {
			candidates: fuseRanks([keywords, closest(ranking, PER_REQUIREMENT)]).slice(0, PER_REQUIREMENT),
			listed: (ranking ? fuseRanks([keywords, closest(ranking, UNJUDGED_MATCHES, SEMANTIC_BAND)]) : keywords).slice(
				0,
				UNJUDGED_MATCHES,
			),
		};
	});

	const unjudged = (): BoardIdeaResult => ({
		...empty(meaning ? "semantic" : "keywords"),
		requirements: split.requirements.map((text, i) => ({
			text,
			verdict: "unknown",
			matches: perRequirement[i].listed
				.map((id) => byId.get(id))
				.filter((t): t is BoardTicket => Boolean(t))
				.map((t) => toMatch(t)),
		})),
		...(meaning ? { semantic: semanticInfo(meaning) } : {}),
	});

	// Round-robin over the requirements, so each brings its best candidates.
	const union: string[] = [];
	for (let rank = 0; rank < PER_REQUIREMENT && union.length < MAX_IDEA_CANDIDATES; rank++) {
		for (const { candidates } of perRequirement) {
			const id = candidates[rank];
			if (id && !union.includes(id) && union.length < MAX_IDEA_CANDIDATES) union.push(id);
		}
	}
	if (union.length === 0) return unjudged();

	const reqs = split.requirements.map((text, i) => ({ ref: `R${i + 1}`, text }));
	const refs = union.map((id, i) => ({ ref: `T${i + 1}`, ticket: byId.get(id) as BoardTicket }));
	const judged = parseIdeaJudgement(
		await input.complete(buildIdeaJudgePrompt(reqs, refs, input.appLanguage), SYSTEM_PROMPT, "BoardIdeaJudge"),
		new Set(reqs.map((r) => r.ref)),
		new Set(refs.map((r) => r.ref)),
	);
	if (!judged) return unjudged();

	const byRef = new Map(refs.map((r) => [r.ref, r.ticket]));
	const fallback = unjudged().requirements;
	const requirements: BoardIdeaRequirement[] = reqs.map(({ ref, text }, i) => {
		const verdict = judged.requirements.get(ref);
		if (!verdict) return fallback[i];
		const matches: BoardAskMatch[] = verdict.tickets.map((t) => toMatch(byRef.get(t) as BoardTicket));
		return { text, verdict: verdict.verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), matches };
	});
	return {
		title: split.title,
		summary: judged.summary,
		requirements,
		mode: "ai",
		searched: tickets.length,
		...(meaning ? { semantic: semanticInfo(meaning) } : {}),
	};
}
