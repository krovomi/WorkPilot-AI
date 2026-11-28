/**
 * The person's AI accounts on the server (`server/routers/ai_accounts.py`):
 * several keys per provider, one the default, which the runs they start use
 * instead of the server's own. The server never sends a key back: only
 * whether one is set, and since when.
 */

export interface AiAccount {
	id: string;
	provider: string;
	name: string;
	is_default: boolean;
	has_key: boolean;
	created_at: string;
	key_set_at: string;
}

export interface AiAccounts {
	accounts: AiAccount[];
	/** Provider → id of its default account. */
	defaults: Record<string, string>;
	/** The providers an account may be saved for. */
	providers: string[];
}

/** The longest name and key the server keeps (`services/ai_accounts.py`). */
export const MAX_NAME_LENGTH = 80;
export const MAX_KEY_LENGTH = 4096;

/** The providers that have accounts, in the server's order, then any other. */
export function providersWithAccounts(data: AiAccounts): string[] {
	const used = new Set(data.accounts.map((a) => a.provider));
	const ordered = data.providers.filter((p) => used.has(p));
	for (const p of used) if (!ordered.includes(p)) ordered.push(p);
	return ordered;
}
