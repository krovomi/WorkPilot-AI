import type { SpecInterviewQuestion } from "../shared/types";
import { getValidatedPythonPath } from "./python-detector";
import { runOneShotLLM } from "./oneshot-llm";

const GENERATION_TIMEOUT_MS = 90000;

const SYSTEM_PROMPT =
	"You output ONLY valid JSON. No prose, no markdown fences.";

/**
 * Service generating spec-interview questions: before planning starts, the
 * agent reads the task description and asks 3-5 targeted questions (edge
 * cases, expected behaviours, constraints). Answers are appended to the spec
 * by the renderer, which drastically reduces rejected plans.
 *
 * Provider-agnostic: the completion runs through {@link runOneShotLLM}, which
 * honours whatever LLM provider the user selected (Claude / Copilot / OpenAI /
 * Windsurf / …) instead of hardcoding the Claude SDK.
 */
export class SpecInterviewService {
	private _pythonPath: string | null = null;
	private autoBuildSourcePath = "";

	configure(pythonPath?: string, autoBuildSourcePath?: string): void {
		if (pythonPath) {
			this._pythonPath = getValidatedPythonPath(
				pythonPath,
				"SpecInterviewService",
			);
		}
		if (autoBuildSourcePath) {
			this.autoBuildSourcePath = autoBuildSourcePath;
		}
	}

	/**
	 * Generate 3-5 clarifying questions for a task description.
	 * Returns null when generation fails (no API access, timeout, bad output);
	 * the caller should degrade gracefully — the interview is always optional.
	 */
	async generateQuestions(
		description: string,
		appLanguage: string,
	): Promise<SpecInterviewQuestion[] | null> {
		const text = await runOneShotLLM({
			prompt: this.buildPrompt(description, appLanguage),
			systemPrompt: SYSTEM_PROMPT,
			pythonPath: this._pythonPath ?? undefined,
			autoBuildSourcePath: this.autoBuildSourcePath || undefined,
			timeoutMs: GENERATION_TIMEOUT_MS,
			debugLabel: "SpecInterview",
		});
		if (!text) return null;
		return this.parseQuestions(text);
	}

	/** Extract the JSON array from the model output (tolerates fences/preamble). */
	private parseQuestions(raw: string): SpecInterviewQuestion[] | null {
		const start = raw.indexOf("[");
		const end = raw.lastIndexOf("]");
		if (start === -1 || end === -1 || end <= start) return null;
		try {
			const parsed = JSON.parse(raw.slice(start, end + 1));
			if (!Array.isArray(parsed)) return null;
			const questions = parsed
				.filter(
					(item): item is Record<string, unknown> =>
						typeof item === "object" && item !== null,
				)
				.map((item, index) => ({
					id: `q${index + 1}`,
					question: String(item.question ?? "").trim(),
					rationale:
						typeof item.rationale === "string" && item.rationale.trim()
							? item.rationale.trim()
							: undefined,
					suggestion:
						typeof item.suggestion === "string" && item.suggestion.trim()
							? item.suggestion.trim()
							: undefined,
				}))
				.filter((question) => question.question.length > 0)
				.slice(0, 5);
			return questions.length > 0 ? questions : null;
		} catch {
			return null;
		}
	}

	/**
	 * The nine areas a spec can be underspecified in, swept in order before
	 * choosing what to ask.
	 *
	 * Adapted from github/spec-kit's `/speckit.clarify` (MIT). The prompt used
	 * to say "focus on edge cases, behaviours, validation rules" — a list of
	 * examples, which a model reads as a direction rather than as a checklist.
	 * Given a budget of five questions and no map of where the gaps could be,
	 * it spends them on the area the description already talks about most,
	 * because that is the area it has the most to say about. A spec that never
	 * mentions failure handling scores no questions on failure handling.
	 *
	 * The sweep costs nothing — the questions asked are still 3 to 5 — and it
	 * changes which five.
	 */
	private static readonly COVERAGE_AREAS = [
		"Functional scope: what is in and out of scope",
		"Domain and data model: entities, fields, relationships, lifecycle",
		"Interaction and UX flow: entry points, states, feedback",
		"Non-functional attributes: performance, security, accessibility, limits",
		"Integrations and dependencies: external systems, versions, contracts",
		"Edge cases and failure handling: empty, invalid, concurrent, offline",
		"Constraints and trade-offs: what may be sacrificed for what",
		"Terminology: terms used inconsistently or left undefined",
		"Completion signals: how anyone knows the task is done",
	];

	private buildPrompt(description: string, appLanguage: string): string {
		const languageName = appLanguage === "fr" ? "French" : "English";
		return [
			"You are a senior software analyst preparing the implementation of a task.",
			"Read the task specification below and produce the 3 to 5 most valuable",
			"clarifying questions to ask BEFORE planning the implementation.",
			"",
			"First, sweep these nine areas and mark each one Clear, Partial or Missing:",
			...SpecInterviewService.COVERAGE_AREAS.map((area) => `  - ${area}`),
			"",
			"Then ask about the Missing and Partial areas whose answer would change",
			"the implementation the most. Do not report the sweep — it decides what",
			"you ask, it is not part of the output.",
			"",
			"Do NOT ask anything already answered by the spec. Prefer a question a",
			"person can answer in one line or by picking between two options; a",
			"question that needs a paragraph will not be answered.",
			"",
			`Write the questions in ${languageName}.`,
			"Output ONLY a JSON array, no markdown fences, with objects of the shape:",
			'[{"question": "...", "rationale": "why this matters (short)", "suggestion": "a plausible default answer (short)"}]',
			"",
			"Task specification:",
			"---",
			description,
			"---",
		].join("\n");
	}
}

export const specInterviewService = new SpecInterviewService();
