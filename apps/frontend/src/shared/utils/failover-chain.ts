/**
 * The automatic failover chain: the ordered list of the AI accounts and
 * providers a task moves to when the one it runs on is out of quota or
 * signed out (Settings → AI accounts → Auto failover).
 *
 * One entry per account the person can order:
 *
 * - `oauth-<id>`: a Claude account signed in with OAuth (Claude profile);
 * - `api-<id>`: an API profile (a key and an endpoint, profiles.json);
 * - `account-<id>`: an account of Settings → AI accounts (an API key on its
 *   provider's own endpoint, ai-accounts.json);
 * - `provider-<name>`: a provider with no account of its own here (Copilot
 *   through `gh`, a key in Settings, Ollama, a coding-agent CLI...).
 *
 * The renderer builds the chain it shows from what is connected and saves the
 * order; the main reads it when a task stops on a limit. Both use this module,
 * and the main re-checks what the renderer sends with `normalizeFailoverOrder`
 * (the renderer is not trusted).
 */
import type { ClaudeAutoSwitchSettings } from "../types/agent";
import { detectProvider } from "./provider-detection";

export type FailoverEntryKind = "oauth" | "api" | "account" | "provider";

export interface FailoverEntryRef {
	readonly id: string;
	readonly kind: FailoverEntryKind;
	/** The Claude profile id, the API profile id, the AI account id or the provider name. */
	readonly key: string;
}

/** An entry with the provider it runs on. */
export interface FailoverCandidate extends FailoverEntryRef {
	readonly provider: string;
}

/** More entries than any real setup has; a longer list is refused. */
export const MAX_FAILOVER_ENTRIES = 64;

const ENTRY = /^(oauth|api|account|provider)-([A-Za-z0-9][A-Za-z0-9._:@-]{0,119})$/;
// An order saved before the chain had kinds named a provider alone ("copilot").
const BARE_PROVIDER = /^(?=.{2,40}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const failoverEntryId = (kind: FailoverEntryKind, key: string): string =>
	`${kind}-${key}`;

/** The entry an id names, or null when it is not one. */
export function parseFailoverEntry(id: string): FailoverEntryRef | null {
	const match = ENTRY.exec(id);
	if (match) {
		return { id, kind: match[1] as FailoverEntryKind, key: match[2] };
	}
	if (BARE_PROVIDER.test(id)) {
		return { id: failoverEntryId("provider", id), kind: "provider", key: id };
	}
	return null;
}

/**
 * The order as the main stores it: entries only, each once, at most
 * MAX_FAILOVER_ENTRIES. Null when the value is not a list of text at all.
 */
export function normalizeFailoverOrder(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_FAILOVER_ENTRIES) return null;
	const order: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return null;
		const entry = parseFailoverEntry(item);
		if (entry && !order.includes(entry.id)) order.push(entry.id);
	}
	return order;
}

/** The provider an API profile's endpoint belongs to; an unknown one speaks Anthropic. */
export function apiProfileProvider(profile: { readonly baseUrl?: string }): string {
	const detected = profile.baseUrl ? detectProvider(profile.baseUrl) : "unknown";
	return detected === "unknown" ? "anthropic" : detected;
}

const isClaude = (provider: string): boolean =>
	provider === "anthropic" || provider === "claude";

/** Whether the person took this entry out of the chain. */
export function isFailoverEntryExcluded(
	entry: FailoverEntryRef,
	excluded: readonly string[],
): boolean {
	return excluded.some(
		(item) => item === entry.id || (entry.kind === "provider" && item === entry.key),
	);
}

export interface FailoverContext {
	/** The provider the task stopped on. */
	readonly provider: string;
	/** The entry it ran on, when known (the active Claude or API profile). */
	readonly currentEntryId?: string;
	/** Entries this task already moved to. */
	readonly tried: ReadonlySet<string>;
	readonly excluded: readonly string[];
	/** Whether an entry can take the task now (signed in, not limited). */
	readonly isUsable: (candidate: FailoverCandidate) => boolean;
	/**
	 * Try the other accounts of the stopped provider before any other
	 * provider, in the chain's order (on unless switched off).
	 */
	readonly sameProviderFirst?: boolean;
}

/**
 * The next entry of the chain for a task that stopped on `provider`.
 *
 * Another account of the same provider is a way out (a second Claude
 * account); the same provider under its generic entry is not, since it would
 * run into the same limit.
 */
export function pickNextFailover(
	chain: readonly FailoverCandidate[],
	context: FailoverContext,
): FailoverCandidate | null {
	const sameProvider = (candidate: FailoverCandidate): boolean =>
		candidate.provider === context.provider ||
		(isClaude(candidate.provider) && isClaude(context.provider));
	const eligible = chain.filter(
		(candidate) =>
			candidate.id !== context.currentEntryId &&
			!context.tried.has(candidate.id) &&
			!isFailoverEntryExcluded(candidate, context.excluded) &&
			!(candidate.kind === "provider" && sameProvider(candidate)),
	);
	const ordered =
		context.sameProviderFirst === false
			? eligible
			: [...eligible.filter(sameProvider), ...eligible.filter((c) => !sameProvider(c))];
	return ordered.find((candidate) => context.isUsable(candidate)) ?? null;
}

const SWITCHES = [
	"enabled",
	"proactiveSwapEnabled",
	"autoSwitchOnRateLimit",
	"autoSwitchOnAuthFailure",
	"sameProviderFirst",
] as const;
const PERCENTS = ["sessionThreshold", "weeklyThreshold"] as const;

/**
 * The part of an auto-switch update the main keeps: known switches as
 * booleans, thresholds as whole percents from 50 to 99. Null when nothing
 * valid is left.
 */
export function sanitizeAutoSwitchUpdate(
	raw: unknown,
): Partial<ClaudeAutoSwitchSettings> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	const update: Partial<ClaudeAutoSwitchSettings> = {};
	for (const key of SWITCHES) {
		if (typeof input[key] === "boolean") update[key] = input[key];
	}
	for (const key of PERCENTS) {
		const value = input[key];
		if (typeof value === "number" && Number.isInteger(value) && value >= 50 && value <= 99) {
			update[key] = value;
		}
	}
	return Object.keys(update).length > 0 ? update : null;
}
