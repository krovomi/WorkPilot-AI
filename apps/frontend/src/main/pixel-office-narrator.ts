/**
 * Pixel Office mini-scenes written by a model (`PIXEL_OFFICE_NARRATE`).
 *
 * The renderer asks for a scene with a kind, roles, provider families and a
 * language from closed lists, and a spec number made of digits. Nothing else
 * reaches the prompt: no task title, no description, nothing a ticket could
 * have written, so the model only ever reads text this file wrote. The answer
 * is shown as text, cut to one line.
 */

import {
	NARRATIVE_KINDS,
	NARRATIVE_LANGUAGES,
	NARRATIVE_ROLES,
	type NarrativeRequest,
	PROVIDER_FAMILIES,
} from "../shared/types/pixel-office";

/** Longest scene shown, once the model's answer is cleaned. */
export const NARRATIVE_TEXT_MAX = 200;

const OPTIONAL_FIELDS = {
	from: NARRATIVE_ROLES,
	to: NARRATIVE_ROLES,
	fromFamily: PROVIDER_FAMILIES,
	toFamily: PROVIDER_FAMILIES,
} as const;

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
	return (list as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

/** The request, field by field, or null as soon as one field is wrong. */
export function parseNarrativeRequest(raw: unknown): NarrativeRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const kind = oneOf(NARRATIVE_KINDS, value.kind);
	const language = oneOf(NARRATIVE_LANGUAGES, value.language);
	const { spec } = value;
	if (!kind || !language) return null;
	if (typeof spec !== "string" || !/^\d{0,6}$/.test(spec)) return null;
	const request: NarrativeRequest = { kind, spec, language };
	for (const [key, list] of Object.entries(OPTIONAL_FIELDS)) {
		if (value[key] === undefined) continue;
		const field = oneOf<string>(list, value[key]);
		if (!field) return null;
		Object.assign(request, { [key]: field });
	}
	return request;
}

const SCENES: Record<NarrativeRequest["kind"], string> = {
	"plan-ready": "the planner hands the finished plan to the coder",
	"handed-to-qa": "the coder hands the finished work to the QA reviewer",
	"qa-sent-back": "the QA reviewer sends the work back to the QA fixer with notes",
	"qa-approved":
		"the QA reviewer approves the work; it now waits for the person's review",
	shipped: "the task is delivered; the office celebrates",
	stumbled: "the agent hits an error and the task stops",
};

const ROLE_NAMES: Record<NonNullable<NarrativeRequest["from"]>, string> = {
	planner: "the Planner",
	coder: "the Coder",
	reviewer: "the QA Reviewer",
	fixer: "the QA Fixer",
	you: "the person",
};

const LANGUAGE_NAMES: Record<NarrativeRequest["language"], string> = {
	en: "English",
	fr: "French",
};

export const NARRATIVE_SYSTEM_PROMPT = [
	"You write one-sentence scenes for a pixel-art office where AI agents work on software tasks.",
	"Light, warm, playful tone; no emoji, no quotes around the sentence, no markdown.",
].join(" ");

function cast(
	role: NarrativeRequest["from"],
	family: NarrativeRequest["fromFamily"],
): string {
	if (!role) return "";
	return family ? `${ROLE_NAMES[role]} (runs on ${family})` : ROLE_NAMES[role];
}

/** The prompt for one scene, written from closed lists only. */
export function buildNarrativePrompt(request: NarrativeRequest): string {
	const agents = [
		cast(request.from, request.fromFamily),
		cast(request.to, request.toFamily),
	].filter(Boolean);
	return [
		`Scene: ${SCENES[request.kind]}.`,
		agents.length > 0 ? `Agents: ${agents.join(", then ")}.` : "",
		request.spec ? `Spec number: ${request.spec}.` : "",
		`Write the scene in ${LANGUAGE_NAMES[request.language]}, one sentence, at most 25 words.`,
	]
		.filter(Boolean)
		.join("\n");
}

/** A control character (C0, DEL, C1) breaks a one-line caption. */
function isControl(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

const QUOTES = new Set(['"', "'", "«", "»", "“", "”"]);

/** The model's answer as a scene: one line, no control characters, bounded. */
export function narrativeText(answer: string | null): string | null {
	if (!answer) return null;
	let flat = "";
	for (const char of answer) {
		flat += isControl(char.codePointAt(0) ?? 0) ? " " : char;
	}
	let line = flat.replace(/\s+/g, " ").trim();
	while (line && QUOTES.has(line[0])) line = line.slice(1);
	while (line && QUOTES.has(line[line.length - 1])) line = line.slice(0, -1);
	line = line.trim();
	if (!line) return null;
	return line.length > NARRATIVE_TEXT_MAX
		? `${line.slice(0, NARRATIVE_TEXT_MAX - 1)}…`
		: line;
}
