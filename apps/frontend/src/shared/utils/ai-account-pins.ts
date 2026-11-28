/**
 * The AI account a project or a Kanban card pins, per provider: the card's
 * pin first, then the project's, then the provider's default account
 * (Settings → AI accounts). A pin is only an id: the main process looks it up
 * in its own store, for the provider it names, and falls back to the default
 * when the account is gone or has no key. Nothing here holds a key.
 *
 * The key of a pin is the provider of the account: one of
 * `AI_ACCOUNT_PROVIDERS` (`gemini` is written `google`) or `claude`, whose
 * accounts are its OAuth profiles (the value is then a profile id).
 */

import {
	type AiAccountPins,
	accountProviderOf,
	CLAUDE_ACCOUNT_PROVIDER,
} from "../types/ai-accounts";
import { isClaudeProvider } from "./task-engine";

/** Longest id a pin may carry (a UUID, a profile id). */
const MAX_PIN_ID_LENGTH = 128;

/** The key a pin for `provider` is stored under, or undefined when it has no accounts. */
export function pinProviderOf(provider: string | undefined | null): string | undefined {
	if (isClaudeProvider(provider)) return CLAUDE_ACCOUNT_PROVIDER;
	return accountProviderOf(provider);
}

function isPinId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PIN_ID_LENGTH &&
		// Printable ASCII without spaces: ids are UUIDs and profile slugs.
		/^[\x21-\x7e]+$/.test(value)
	);
}

/**
 * The pins of `value` that name a provider with accounts and a well-formed id,
 * keyed by that provider; undefined when none is left. `value` comes from a
 * file the renderer wrote (task_metadata.json, project settings): anything
 * else in it is dropped.
 */
export function sanitizeAccountPins(value: unknown): AiAccountPins | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const pins: AiAccountPins = {};
	for (const [provider, id] of Object.entries(value as Record<string, unknown>)) {
		const key = pinProviderOf(provider);
		if (key && isPinId(id)) pins[key] = id;
	}
	return Object.keys(pins).length > 0 ? pins : undefined;
}

/** The pins a task runs with: the project's, each replaced by the card's own. */
export function mergeAccountPins(
	taskPins: unknown,
	projectPins: unknown,
): AiAccountPins | undefined {
	const merged = { ...sanitizeAccountPins(projectPins), ...sanitizeAccountPins(taskPins) };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The account pinned for `provider` (aliases included), or undefined. */
export function pinnedAccountOf(
	pins: AiAccountPins | undefined,
	provider: string | undefined | null,
): string | undefined {
	const key = pinProviderOf(provider);
	return key ? pins?.[key] : undefined;
}

/**
 * `pins` with `provider` set to `id`, or removed when `id` is empty; undefined
 * once no pin is left, so that a saved file loses the field.
 */
export function withAccountPin(
	pins: AiAccountPins | undefined,
	provider: string,
	id: string | null | undefined,
): AiAccountPins | undefined {
	const key = pinProviderOf(provider);
	if (!key) return pins;
	const next: AiAccountPins = { ...pins };
	if (id) next[key] = id;
	else delete next[key];
	return Object.keys(next).length > 0 ? next : undefined;
}

/** The pins of `pins` for the providers a card uses; undefined when none is left. */
export function pinsForProviders(
	pins: AiAccountPins | undefined,
	providers: readonly string[],
): AiAccountPins | undefined {
	if (!pins) return undefined;
	const used = new Set(providers.map(pinProviderOf));
	const kept = Object.fromEntries(Object.entries(pins).filter(([key]) => used.has(key)));
	return Object.keys(kept).length > 0 ? kept : undefined;
}
