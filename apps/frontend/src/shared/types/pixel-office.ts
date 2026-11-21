/**
 * Pixel Office types the renderer and the main process both read: the
 * provider families the characters are dressed in, and the request for an
 * LLM-written mini-scene (`PIXEL_OFFICE_NARRATE`).
 */

/** One shirt colour per provider family, so a glance tells who runs what. */
export const PROVIDER_FAMILIES = [
	"anthropic",
	"openai",
	"google",
	"ollama",
	"copilot",
	"grok",
	"custom",
] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

/** What just happened to a task, as a scene in the office. */
export const NARRATIVE_KINDS = [
	"plan-ready",
	"handed-to-qa",
	"qa-sent-back",
	"qa-approved",
	"shipped",
	"stumbled",
] as const;

export type NarrativeKind = (typeof NARRATIVE_KINDS)[number];

/** The agents a scene can name: the pipeline's roles, and the person. */
export const NARRATIVE_ROLES = [
	"planner",
	"coder",
	"reviewer",
	"fixer",
	"you",
] as const;

export type NarrativeRole = (typeof NARRATIVE_ROLES)[number];

/** The languages a scene can be written in (the app's own). */
export const NARRATIVE_LANGUAGES = ["en", "fr"] as const;

export type NarrativeLanguage = (typeof NARRATIVE_LANGUAGES)[number];

/**
 * A scene to write: every field is checked again by the main process. Only
 * closed lists and a spec number: the model never sees the task's content.
 */
export interface NarrativeRequest {
	kind: NarrativeKind;
	/** The spec's number (`042`), or empty. */
	spec: string;
	from?: NarrativeRole;
	to?: NarrativeRole;
	/** The provider family the first agent runs on. */
	fromFamily?: ProviderFamily;
	toFamily?: ProviderFamily;
	language: NarrativeLanguage;
}

export type NarrativeResult =
	| { success: true; text: string }
	| { success: false };
