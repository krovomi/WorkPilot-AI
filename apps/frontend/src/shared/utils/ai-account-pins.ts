/**
 * The AI account a project or a Kanban card pins, per provider: the card's
 * pin first, then the project's, then the provider's default account
 * (Settings → AI accounts). A pin is only an id: the main process looks it up
 * in its own store, for the provider it names, and falls back to the default
 * when the account is gone or has no key. Nothing here holds a key.
 *
 * The key of a pin is the provider of the account: one of
 * `AI_ACCOUNT_PROVIDERS` (`gemini` is written `google`), `claude`, whose
 * accounts are its OAuth profiles (the value is then a profile id), or a
 * coding-agent CLI of `AI_LOGIN_PROVIDERS` (a sign-in account). OpenAI has
 * two: `openai` for a key, `codex` for a Codex CLI sign-in; a card or a
 * project pins one of them, never both.
 */

import {
	type AiAccountPins,
	accountProviderOf,
	CLAUDE_ACCOUNT_PROVIDER,
	loginProviderOf,
} from "../types/ai-accounts";
import { isClaudeProvider } from "./task-engine";

/** Longest id a pin may carry (a UUID, a profile id). */
const MAX_PIN_ID_LENGTH = 128;

/**
 * The key an API-key or Claude pin for `provider` is stored under, or
 * undefined when it has no such accounts.
 */
export function pinProviderOf(provider: string | undefined | null): string | undefined {
	if (isClaudeProvider(provider)) return CLAUDE_ACCOUNT_PROVIDER;
	return accountProviderOf(provider);
}

/**
 * Every key a pin for `provider` may be stored under: its API-key or Claude
 * key, then its CLI sign-in key (`openai` → `openai`, `codex`). Empty when
 * the provider has no accounts.
 */
export function pinKeysOf(provider: string | undefined | null): string[] {
	const keys = [pinProviderOf(provider), loginProviderOf(provider)];
	return [...new Set(keys.filter((key): key is string => !!key))];
}

/** A CLI pin that shares its card provider with an API-key pin: Codex is OpenAI's. */
const OWNER_OF_LOGIN_PIN: Readonly<Record<string, string>> = { codex: "openai" };

/** The keys that replace one another: a pin of one drops the others (`openai`, `codex`). */
function pinGroupOf(provider: string): string[] {
	const id = provider.trim().toLowerCase();
	return pinKeysOf(OWNER_OF_LOGIN_PIN[id] ?? id);
}

/** The key a stored pin is read under: an API-key, Claude or CLI provider. */
function storedPinKeyOf(provider: string): string | undefined {
	return pinProviderOf(provider) ?? loginProviderOf(provider);
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
		const key = storedPinKeyOf(provider);
		if (key && isPinId(id)) pins[key] = id;
	}
	return Object.keys(pins).length > 0 ? pins : undefined;
}

/**
 * The pins a task runs with: the project's, each replaced by the card's own.
 * A card that pins OpenAI's key or its Codex sign-in replaces the project's
 * pin of either, so that the task does not get one of each.
 */
export function mergeAccountPins(
	taskPins: unknown,
	projectPins: unknown,
): AiAccountPins | undefined {
	const project = { ...sanitizeAccountPins(projectPins) };
	const task = sanitizeAccountPins(taskPins) ?? {};
	for (const key of Object.keys(task)) {
		for (const sibling of pinGroupOf(key)) delete project[sibling];
	}
	const merged = { ...project, ...task };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The API-key or Claude account pinned for `provider` (aliases included), or undefined. */
export function pinnedAccountOf(
	pins: AiAccountPins | undefined,
	provider: string | undefined | null,
): string | undefined {
	const key = pinProviderOf(provider);
	return key ? pins?.[key] : undefined;
}

/** The CLI sign-in account pinned for `provider` (`openai` reads Codex's), or undefined. */
export function pinnedLoginOf(
	pins: AiAccountPins | undefined,
	provider: string | undefined | null,
): string | undefined {
	const key = loginProviderOf(provider);
	return key ? pins?.[key] : undefined;
}

/**
 * `pins` with `provider` set to `id`, or removed when `id` is empty; undefined
 * once no pin is left, so that a saved file loses the field. `kind` says
 * which account `id` is: an API key (or a Claude profile) or a CLI sign-in.
 * Either replaces the other: OpenAI keeps its key or its Codex sign-in.
 */
export function withAccountPin(
	pins: AiAccountPins | undefined,
	provider: string,
	id: string | null | undefined,
	kind: "key" | "login" = "key",
): AiAccountPins | undefined {
	const own = pinKeysOf(provider);
	if (own.length === 0) return pins;
	// A CLI provider (Copilot) has only a sign-in key, whatever `kind` says.
	const key = kind === "login" ? loginProviderOf(provider) : own[0];
	const next: AiAccountPins = { ...pins };
	for (const sibling of pinGroupOf(provider)) delete next[sibling];
	if (id && key) next[key] = id;
	return Object.keys(next).length > 0 ? next : undefined;
}

/** The pins of `pins` for the providers a card uses; undefined when none is left. */
export function pinsForProviders(
	pins: AiAccountPins | undefined,
	providers: readonly string[],
): AiAccountPins | undefined {
	if (!pins) return undefined;
	const used = new Set(providers.flatMap(pinKeysOf));
	const kept = Object.fromEntries(Object.entries(pins).filter(([key]) => used.has(key)));
	return Object.keys(kept).length > 0 ? kept : undefined;
}
