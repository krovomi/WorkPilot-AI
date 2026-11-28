/**
 * « Interroger le tableau » (docs/architecture/board-ask.md): a question in
 * any language, answered with the tickets of the board that relate to it,
 * whatever language they were written in.
 *
 * Three steps, the model of the person's chosen provider in two of them
 * (`runOneShotLLM`, so every provider, Claude included, which has no
 * embeddings):
 *
 * 1. **Understand.** The model turns the question (and, for a follow-up, the
 *    conversation) into one standalone question and the words a ticket about
 *    it would use, in every language the board is written in.
 * 2. **Search.** A keyword search ({@link KeywordIndex}) over every ticket
 *    and, when an embeddings model can be asked (`semantic-search.ts`), a
 *    ranking by meaning, run while the model understands the question; the
 *    two rankings are fused ({@link fuseRanks}) and keep the best
 *    candidates. A small board is read whole.
 * 3. **Judge.** The model reads the candidates and says, for each one that
 *    relates, how much of the question it covers and why, then answers citing
 *    them.
 *
 * Without an answer from the model (no provider, a timeout, unreadable
 * output) the fused ranking answers alone, or the keyword search when no
 * embeddings model could be asked: the panel always has something.
 * Ticket text, the question and the conversation enter the prompts as quoted
 * data (S2); what comes back is read as JSON into closed lists and bounded
 * strings, and a ticket is only ever named by a reference this code gave.
 */

import type {
	BoardAskCoverage,
	BoardAskMatch,
	BoardAskResult,
	BoardAskSemantic,
	BoardAskTurn,
	Task,
} from "../../shared/types";
import { BOARD_ASK_COVERAGES, BOARD_ASK_LIMITS } from "../../shared/types/board-ask";
import { detectLanguages, KeywordIndex, type QueryTerm } from "../../shared/utils/board-ask-search";
import { quoteUntrusted } from "../security/untrusted-text";
import type { SemanticFn, SemanticRanking } from "./semantic-search";
import { type BoardTicket, ticketDigest, ticketDocument, ticketMeaning, toTicket } from "./tickets";

/** A board this small is read whole by the model: nothing to miss. */
export const SMALL_BOARD = 30;
/** Candidates the model reads on a larger board. */
export const MAX_CANDIDATES = 30;
/** Tickets a keyword answer lists. */
const KEYWORD_RESULTS = 15;
const DIGEST_CHARS = 900;
const MAX_TERMS = 60;
const MAX_TERM_CHARS = 60;
const MAX_ANSWER_CHARS = 3000;
const MAX_REASON_CHARS = 300;
/** Reciprocal rank fusion's constant: a rank's weight is 1 / (RRF_K + rank). */
const RRF_K = 60;
/**
 * Without a model to judge them, the tickets ranked by meaning that are
 * listed: those within this much of the closest one's cosine.
 */
export const SEMANTIC_BAND = 0.12;
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	en: "English",
	fr: "French",
	es: "Spanish",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
};

const SYSTEM_PROMPT = "You output ONLY valid JSON. No prose, no markdown fences.";

/** One completion: the prompt in, the model's text out, null when it failed. */
export type CompletionFn = (prompt: string, systemPrompt: string, label: string) => Promise<string | null>;

export interface AskBoardInput {
	tasks: readonly Task[];
	question: string;
	history?: readonly BoardAskTurn[];
	/** The app's language, used when the question's own cannot be told. */
	appLanguage: string;
	complete: CompletionFn;
	readSpec?: (task: Task) => string;
	/** Ranks the tickets by meaning; absent when the person turned it off. */
	semantic?: SemanticFn;
}

interface QueryPlan {
	question: string;
	terms: string[];
}

interface Judged {
	answer: string;
	matches: { ref: string; coverage: BoardAskCoverage; reason: string }[];
}

function jsonObject(raw: string): Record<string, unknown> | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function oneLine(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function conversation(history: readonly BoardAskTurn[] | undefined): string {
	const turns = (history ?? []).slice(-BOARD_ASK_LIMITS.historyTurns);
	if (turns.length === 0) return "";
	const text = turns
		.map((turn) => `Q: ${turn.question.slice(0, 500)}\nA: ${turn.answer.slice(0, 800)}`)
		.join("\n\n");
	return quoteUntrusted("Earlier in this conversation", text);
}

export function buildUnderstandPrompt(
	question: string,
	history: readonly BoardAskTurn[] | undefined,
	boardLanguages: readonly string[],
): string {
	const languages = [...new Set(["en", ...boardLanguages])].map((code) => LANGUAGE_NAMES[code] ?? code);
	const earlier = conversation(history);
	return [
		"A person searches the tickets of a software project's board (features, fixes, tasks) to find every",
		"ticket related to their question, for instance to learn whether a feature was already built.",
		"",
		"1. Rewrite the question as one standalone question (resolve what a follow-up refers to).",
		`2. List the words and short phrases a ticket about it could contain, in each of: ${languages.join(", ")}.`,
		"   Include synonyms, the usual technical names (route, component, file or table names), and the",
		"   related concepts a developer would write (for an admin page: administration, back-office, admin",
		"   panel, settings, dashboard, permissions...). Single words or phrases of at most 3 words.",
		`   At most ${MAX_TERMS} items.`,
		"",
		'Output ONLY a JSON object: {"question": "...", "terms": ["...", "..."]}',
		"",
		...(earlier ? [earlier, ""] : []),
		quoteUntrusted("Question", question),
	].join("\n");
}

export function parseQueryPlan(raw: string | null): QueryPlan | null {
	if (!raw) return null;
	const parsed = jsonObject(raw);
	if (!parsed) return null;
	const terms = (Array.isArray(parsed.terms) ? parsed.terms : [])
		.map((term) => oneLine(term, MAX_TERM_CHARS))
		.filter(Boolean)
		.slice(0, MAX_TERMS);
	const question = oneLine(parsed.question, BOARD_ASK_LIMITS.question);
	if (!question && terms.length === 0) return null;
	return { question, terms };
}

export function buildJudgePrompt(
	question: string,
	candidates: readonly { ref: string; ticket: BoardTicket }[],
	appLanguage: string,
	history: readonly BoardAskTurn[] | undefined,
): string {
	const fallback = LANGUAGE_NAMES[appLanguage] ?? "English";
	const tickets = candidates.map(({ ref, ticket }) => `[${ref}]\n${ticketDigest(ticket, DIGEST_CHARS)}`).join("\n\n");
	const earlier = conversation(history);
	return [
		"A person asks a question about the tickets of a software project's board, often to learn whether",
		"a feature they plan was already built, even partly. Tickets may be written in another language",
		"than the question: judge them by meaning, not by shared words.",
		"",
		"For each ticket that relates to the question, give:",
		'- "coverage": "full" when it already delivers or plans what the question is about, "partial" when it',
		'  covers part of it, "related" when it only touches the subject;',
		'- "reason": one short sentence saying what it did or plans, and how that relates.',
		"Leave out the tickets that do not relate. Keep the tickets' state in mind: a planned or abandoned",
		"ticket did not deliver anything.",
		"",
		'Then write "answer": a short answer to the question (at most 5 sentences) that cites tickets by their',
		"reference in brackets, like [T3]. Say plainly when nothing relates.",
		"",
		`Write "answer" and every "reason" in the language of the question; if it cannot be told, in ${fallback}.`,
		'Output ONLY a JSON object: {"answer": "...", "matches": [{"ref": "T1", "coverage": "full", "reason": "..."}]}',
		"",
		...(earlier ? [earlier, ""] : []),
		quoteUntrusted("Question", question),
		"",
		quoteUntrusted("Tickets", tickets || "(none)"),
	].join("\n");
}

export function parseJudgement(raw: string | null, refs: ReadonlySet<string>): Judged | null {
	if (!raw) return null;
	const parsed = jsonObject(raw);
	if (!parsed || typeof parsed.answer !== "string") return null;
	const seen = new Set<string>();
	const matches: Judged["matches"] = [];
	for (const item of Array.isArray(parsed.matches) ? parsed.matches : []) {
		if (typeof item !== "object" || item === null) continue;
		const { ref, coverage, reason } = item as Record<string, unknown>;
		const key = typeof ref === "string" ? ref.trim().replace(/^\[|\]$/g, "") : "";
		if (!refs.has(key) || seen.has(key)) continue;
		const level = BOARD_ASK_COVERAGES.find((c) => c === coverage) ?? "related";
		seen.add(key);
		matches.push({ ref: key, coverage: level, reason: oneLine(reason, MAX_REASON_CHARS) });
	}
	return { answer: parsed.answer.trim().slice(0, MAX_ANSWER_CHARS), matches };
}

const COVERAGE_ORDER: Readonly<Record<BoardAskCoverage, number>> = { full: 0, partial: 1, related: 2 };

function toMatch(ticket: BoardTicket, extra: Partial<BoardAskMatch> = {}): BoardAskMatch {
	return {
		taskId: ticket.id,
		title: ticket.title,
		state: ticket.state,
		...(ticket.updatedAt ? { updatedAt: ticket.updatedAt } : {}),
		...(ticket.archived ? { archived: true } : {}),
		...extra,
	};
}

/**
 * `[T7]` references of the answer turned into `[n]`, the 1-based position of
 * that ticket in the matches; a reference to a ticket not kept is dropped.
 */
export function citeMatches(answer: string, order: readonly string[]): string {
	return answer
		.replace(/\[(T\d+)(?:\s*,\s*(T\d+))*\]/g, (whole) => {
			const cited = [...whole.matchAll(/T\d+/g)]
				.map((m) => order.indexOf(m[0]))
				.filter((i) => i >= 0)
				.map((i) => `[${i + 1}]`);
			return cited.join("");
		})
		.replace(/[ \t]+([.,;:!?])/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * Several rankings of ids made one (reciprocal rank fusion): an id ranked
 * well by any of them comes up, and one ranked well by both comes first.
 */
export function fuseRanks(rankings: readonly (readonly string[])[], k = RRF_K): string[] {
	const score = new Map<string, number>();
	for (const ranking of rankings) {
		ranking.forEach((id, rank) => {
			score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
		});
	}
	return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The closest tickets of a ranking by meaning: `top` of them, or those within the band. */
function closest(meaning: SemanticRanking | null, top: number, band?: number): string[] {
	if (!meaning || meaning.scores.length === 0) return [];
	const best = meaning.scores[0].score;
	return meaning.scores
		.filter((s) => band === undefined || s.score >= best - band)
		.slice(0, top)
		.map((s) => s.id);
}

function semanticInfo(meaning: SemanticRanking): BoardAskSemantic {
	return { ...meaning.source, indexed: meaning.indexed, total: meaning.total };
}

function recency(ticket: BoardTicket): number {
	return ticket.updatedAt ? Date.parse(ticket.updatedAt) : 0;
}

export async function askBoard(input: AskBoardInput): Promise<BoardAskResult> {
	const question = input.question.trim().slice(0, BOARD_ASK_LIMITS.question);
	const tickets = input.tasks.map((task) => toTicket(task, input.readSpec)).filter((t) => t.title || t.description);
	if (tickets.length === 0 || !question) {
		return { answer: "", matches: [], mode: "keywords", searched: tickets.length };
	}
	const byId = new Map(tickets.map((t) => [t.id, t]));
	const index = new KeywordIndex(tickets.map(ticketDocument));
	const boardLanguages = detectLanguages(tickets.map((t) => `${t.title} ${t.description}`)).slice(0, 4);

	// A follow-up means what it means after the question before it.
	const meaningQuery = [...(input.history ?? []).slice(-1).map((turn) => turn.question), question].join("\n");
	const meaningAsked = input.semantic
		? input
				.semantic(
					meaningQuery,
					tickets.map((t) => ({ id: t.id, text: ticketMeaning(t) })),
				)
				.catch(() => null)
		: Promise.resolve(null);
	const [understood, meaning] = await Promise.all([
		input.complete(buildUnderstandPrompt(question, input.history, boardLanguages), SYSTEM_PROMPT, "BoardAskUnderstand"),
		meaningAsked,
	]);
	const plan = parseQueryPlan(understood);
	const standalone = plan?.question || question;
	const query: QueryTerm[] = [
		{ text: question, weight: 1 },
		...(plan && plan.question !== question ? [{ text: plan.question, weight: 1 }] : []),
		...(plan?.terms ?? []).map((text) => ({ text, weight: 0.8 })),
		// A follow-up's words are in the conversation more than in itself.
		...(input.history ?? []).slice(-1).map((turn) => ({ text: turn.question, weight: 0.4 })),
	];
	const keywordIds = index.search(query, Math.max(KEYWORD_RESULTS, MAX_CANDIDATES)).map((hit) => hit.id);
	const hits = fuseRanks([keywordIds, closest(meaning, MAX_CANDIDATES)]);
	const listed = meaning ? fuseRanks([keywordIds, closest(meaning, KEYWORD_RESULTS, SEMANTIC_BAND)]) : keywordIds;
	const semantic = meaning ? { semantic: semanticInfo(meaning) } : {};

	let candidates: BoardTicket[];
	if (tickets.length <= SMALL_BOARD) {
		const rank = new Map(hits.map((id, i) => [id, i]));
		candidates = [...tickets].sort(
			(a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || recency(b) - recency(a),
		);
	} else {
		candidates = hits.map((id) => byId.get(id)).filter((t): t is BoardTicket => Boolean(t));
	}
	candidates = candidates.slice(0, Math.max(SMALL_BOARD, MAX_CANDIDATES));
	const expandedTerms = plan?.terms.length ? plan.terms : undefined;

	const keywordAnswer = (): BoardAskResult => ({
		answer: "",
		matches: listed
			.slice(0, KEYWORD_RESULTS)
			.map((id) => byId.get(id))
			.filter((t): t is BoardTicket => Boolean(t))
			.map((t) => toMatch(t)),
		mode: meaning ? "semantic" : "keywords",
		searched: tickets.length,
		...(expandedTerms ? { expandedTerms } : {}),
		...semantic,
	});
	if (candidates.length === 0) return keywordAnswer();

	const refs = candidates.map((ticket, i) => ({ ref: `T${i + 1}`, ticket }));
	const judged = parseJudgement(
		await input.complete(
			buildJudgePrompt(standalone, refs, input.appLanguage, input.history),
			SYSTEM_PROMPT,
			"BoardAskJudge",
		),
		new Set(refs.map((r) => r.ref)),
	);
	if (!judged) return keywordAnswer();

	const byRef = new Map(refs.map((r) => [r.ref, r.ticket]));
	const kept = judged.matches
		.map((m, i) => ({ ...m, position: i }))
		.sort((a, b) => COVERAGE_ORDER[a.coverage] - COVERAGE_ORDER[b.coverage] || a.position - b.position);
	return {
		answer: citeMatches(
			judged.answer,
			kept.map((m) => m.ref),
		),
		matches: kept.map((m) =>
			toMatch(byRef.get(m.ref) as BoardTicket, {
				coverage: m.coverage,
				...(m.reason ? { reason: m.reason } : {}),
			}),
		),
		mode: "ai",
		searched: tickets.length,
		...(expandedTerms ? { expandedTerms } : {}),
		...semantic,
	};
}
