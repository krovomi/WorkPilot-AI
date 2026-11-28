import type { SpecInterviewQuestion } from "../shared/types";
import { runOneShotLLM } from "./oneshot-llm";
import { getValidatedPythonPath } from "./python-detector";
import { quoteUntrusted } from "./security/untrusted-text";

const REVIEW_TIMEOUT_MS = 45000;
const MAX_QUESTIONS = 3;
/** The card text the review reads, at most (a short card is far below). */
const MAX_CARD_CHARS = 4000;

const SYSTEM_PROMPT = "You output ONLY valid JSON. No prose, no markdown fences.";

/** What the review answers about a short card. */
export interface ReadinessVerdict {
	ready: boolean;
	questions: SpecInterviewQuestion[];
}

/**
 * The AI half of the pre-analysis (docs/architecture/task-readiness.md): a
 * card with a title and little else is read once before it starts, and the
 * review says whether a coding agent could build it without guessing, or asks
 * at most three short questions. Provider-agnostic through
 * {@link runOneShotLLM}; the card text enters the prompt as quoted data (S2).
 */
export class ReadinessReviewService {
	private pythonPath: string | null = null;
	private autoBuildSourcePath = "";

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) this.pythonPath = getValidatedPythonPath(pythonPath, "ReadinessReview");
		if (autoBuildSourcePath) this.autoBuildSourcePath = autoBuildSourcePath;
	}

	/** The verdict, or null when the review could not run (the card then starts). */
	async review(title: string, description: string, appLanguage: string): Promise<ReadinessVerdict | null> {
		const text = await runOneShotLLM({
			prompt: buildReadinessPrompt(title, description, appLanguage),
			systemPrompt: SYSTEM_PROMPT,
			pythonPath: this.pythonPath ?? undefined,
			autoBuildSourcePath: this.autoBuildSourcePath || undefined,
			timeoutMs: REVIEW_TIMEOUT_MS,
			debugLabel: "ReadinessReview",
		});
		return text ? parseReadinessVerdict(text) : null;
	}
}

export function buildReadinessPrompt(title: string, description: string, appLanguage: string): string {
	const languageName = appLanguage === "fr" ? "French" : "English";
	const card = `${title}\n\n${description}`.trim().slice(0, MAX_CARD_CHARS);
	return [
		"A coding agent is about to plan and implement the task card below in the user's repository.",
		"The card is short. Decide whether the agent can build what the person wants without guessing:",
		"what to change, where, and how anyone knows it is done.",
		"",
		"If it can, answer ready. If an answer would change the work, answer not ready and ask at most",
		`${MAX_QUESTIONS} short questions a person can answer in one line.`,
		"Never ask what the card already says, and never ask for the sake of asking.",
		'A "suggestion" is your best guess at the answer itself, in a few words, as the person would write it',
		'(for a page: "the sign-in page"), never an instruction or a hint such as "Describe the bug".',
		"Leave it out when the card gives you nothing to guess from.",
		"",
		`Write the questions in ${languageName}.`,
		'Output ONLY a JSON object: {"ready": true} or {"ready": false, "questions": [{"question": "...", "suggestion": "..."}]}',
		"",
		quoteUntrusted("Task card", card),
	].join("\n");
}

/** The verdict in the model's text (tolerates fences and preamble), or null. */
export function parseReadinessVerdict(raw: string): ReadinessVerdict | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { ready, questions } = parsed as { ready?: unknown; questions?: unknown };
	if (typeof ready !== "boolean") return null;
	if (ready) return { ready: true, questions: [] };
	const asked = (Array.isArray(questions) ? questions : [])
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			question: typeof item.question === "string" ? item.question.trim().slice(0, 300) : "",
			suggestion:
				typeof item.suggestion === "string" && item.suggestion.trim()
					? item.suggestion.trim().slice(0, 300)
					: undefined,
		}))
		.filter((q) => q.question.length > 0)
		.slice(0, MAX_QUESTIONS)
		.map((q, index) => ({ id: `q${index + 1}`, ...q }));
	// "Not ready" with nothing to ask gives the person nothing to do: let it start.
	return asked.length > 0 ? { ready: false, questions: asked } : { ready: true, questions: [] };
}

export const readinessReviewService = new ReadinessReviewService();
