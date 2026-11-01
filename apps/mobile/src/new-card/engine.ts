/**
 * The engine and priority a new card may ask for, as the server takes them
 * (`shared_board/settings.py`, `CardSettings`). Nothing chosen means nothing
 * sent: the card runs with the deployment's default.
 */

/** A provider the server offers (`GET /api/board/engines`). */
export interface EngineOption {
	provider: string;
	label: string;
	/** How the provider takes an effort level; `"none"` when it takes none. */
	effort: string;
	models: { id: string; label: string }[];
}

export const EFFORT_LEVELS = ["none", "low", "medium", "high", "ultrathink"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The server's `MODEL_PATTERN`: a model id as providers spell them. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export interface EngineChoice {
	provider: string | null;
	/** Free text or a listed id; empty for the provider's default. */
	model: string;
	effort: EffortLevel | null;
	priority: Priority | null;
}

export const NO_CHOICE: EngineChoice = { provider: null, model: "", effort: null, priority: null };

/** Whether the model typed is one the server would take (empty is: it means the default). */
export function isModelValid(model: string): boolean {
	const value = model.trim();
	return value === "" || MODEL_PATTERN.test(value);
}

export interface SettingsPayload {
	engine?: { provider: string; model?: string; thinkingLevel?: EffortLevel };
	priority?: Priority;
}

/**
 * What `createCard` sends as `settings`, or `undefined` when nothing was
 * chosen. A field left out keeps the server's default; an effort is sent only
 * for a provider that takes one.
 */
export function settingsPayload(choice: EngineChoice, engines: readonly EngineOption[]): SettingsPayload | undefined {
	const settings: SettingsPayload = {};
	const option = engines.find((e) => e.provider === choice.provider);
	if (choice.provider && option) {
		const engine: NonNullable<SettingsPayload["engine"]> = { provider: choice.provider };
		const model = choice.model.trim();
		if (model && MODEL_PATTERN.test(model)) engine.model = model;
		if (choice.effort && option.effort !== "none") engine.thinkingLevel = choice.effort;
		settings.engine = engine;
	}
	if (choice.priority) settings.priority = choice.priority;
	return Object.keys(settings).length ? settings : undefined;
}
