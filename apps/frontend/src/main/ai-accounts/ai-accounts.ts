/**
 * The AI accounts saved for the whole app: several API-key accounts per
 * provider, one of them the provider's default. The default account's key is
 * the one the credential manager hands to tasks, connection tests and views
 * (`ai-account-key.ts`); a provider with no default keeps the key typed on its
 * own page (the "main key").
 *
 * `<userData>/config/ai-accounts.json`, written whole (temporary file then
 * rename), mode 0600; each key is stored as `secret-storage.ts` decides
 * (`enc:` with a keyring). Only the main process reads it: the renderer gets
 * `AiAccountView`, which says whether a key is set and nothing more (rule S6).
 * A key always goes to its provider's own endpoint, never to a URL the
 * renderer names.
 *
 * A coding-agent CLI's account (`login-specs.ts`) holds no key: it is a folder
 * the main process creates under `<userData>/config/ai-account-homes/`, where
 * the CLI keeps its own sign-in. Deleting the account deletes the folder.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
	AI_ACCOUNT_PROVIDERS,
	type AiAccountInput,
	type AiAccountView,
} from "../../shared/types/ai-accounts";
import { decryptSecret, encryptSecret } from "../secret-storage";
import { unmaskSecret } from "../utils/masked-secret";
import { isLoginProvider, LOGIN_SPECS } from "./login-specs";

export const MAX_AI_ACCOUNTS = 100;
const MAX_NAME = 80;
const MAX_KEY = 4096;

interface StoredAccount {
	id: string;
	provider: string;
	name: string;
	/** As written to disk: `enc:` ciphertext, or clear without a keyring. */
	apiKey?: string;
	/** A CLI sign-in account: its folder, created by the main process. */
	home?: string;
	createdAt: string;
	keySetAt?: string;
}

interface StoredFile {
	accounts: StoredAccount[];
	defaults: Record<string, string>;
}

export function isAiAccountProvider(value: unknown): value is string {
	return typeof value === "string" && AI_ACCOUNT_PROVIDERS.includes(value);
}

/** A provider with accounts: API keys, or a CLI's sign-ins. */
function isAnyAccountProvider(value: unknown): value is string {
	return isAiAccountProvider(value) || isLoginProvider(value);
}

/** Text without control characters, trimmed and bounded. */
function clean(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	let kept = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 0x1f && code !== 0x7f) kept += char;
	}
	return kept.trim().slice(0, max);
}

function isStoredAccount(value: unknown): value is StoredAccount {
	if (!value || typeof value !== "object") return false;
	const account = value as Record<string, unknown>;
	return (
		typeof account.id === "string" &&
		isAnyAccountProvider(account.provider) &&
		typeof account.name === "string" &&
		typeof account.createdAt === "string" &&
		(account.apiKey === undefined || typeof account.apiKey === "string") &&
		(account.home === undefined || typeof account.home === "string") &&
		(account.keySetAt === undefined || typeof account.keySetAt === "string")
	);
}

function viewOf({ apiKey, home, ...account }: StoredAccount): AiAccountView {
	const spec = LOGIN_SPECS[account.provider];
	if (!spec) return { ...account, hasKey: Boolean(apiKey), kind: "key" };
	return { ...account, hasKey: false, kind: "login", signedIn: home ? spec.signedIn(home) : false };
}

export class AiAccountStore {
	constructor(private readonly filePath: string) {}

	/** Where the CLI accounts' folders live. */
	private get homesRoot(): string {
		return path.join(path.dirname(this.filePath), "ai-account-homes");
	}

	/** `home` when it is a folder of `homesRoot` (a file edited by hand may say otherwise). */
	private ownHome(home: string | undefined): string | undefined {
		if (!home) return undefined;
		const relative = path.relative(this.homesRoot, path.resolve(home));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? home : undefined;
	}

	private read(): StoredFile {
		if (!existsSync(this.filePath)) return { accounts: [], defaults: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
				accounts?: unknown;
				defaults?: unknown;
			};
			const accounts = Array.isArray(parsed.accounts)
				? parsed.accounts
						.filter(isStoredAccount)
						.map((account) => ({ ...account, home: this.ownHome(account.home) }))
				: [];
			const defaults: Record<string, string> = {};
			if (parsed.defaults && typeof parsed.defaults === "object") {
				for (const [provider, id] of Object.entries(parsed.defaults)) {
					// A default only names an account of its own provider.
					if (accounts.some((a) => a.id === id && a.provider === provider)) {
						defaults[provider] = id as string;
					}
				}
			}
			return { accounts, defaults };
		} catch {
			return { accounts: [], defaults: {} };
		}
	}

	private write(file: StoredFile): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, ...file }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporary, this.filePath);
	}

	list(): AiAccountView[] {
		return this.read().accounts.map(viewOf);
	}

	defaults(): Record<string, string> {
		return this.read().defaults;
	}

	get(id: string): AiAccountView | undefined {
		return this.list().find((account) => account.id === id);
	}

	/** The account's key in clear, or undefined (none, or not decryptable now). */
	keyOf(id: string): string | undefined {
		const stored = this.read().accounts.find((account) => account.id === id)?.apiKey;
		return stored ? decryptSecret(stored) : undefined;
	}

	/** The default account of `provider`, with its key in clear, or undefined. */
	defaultOf(provider: string): { account: AiAccountView; apiKey: string } | undefined {
		const id = this.read().defaults[provider];
		if (!id) return undefined;
		const account = this.get(id);
		const apiKey = this.keyOf(id);
		return account && apiKey ? { account, apiKey } : undefined;
	}

	/** The folder of `provider`'s default CLI account, when it has signed in. */
	defaultHomeOf(provider: string): string | undefined {
		const id = this.read().defaults[provider];
		const account = this.read().accounts.find((candidate) => candidate.id === id);
		return account?.home && viewOf(account).signedIn ? account.home : undefined;
	}

	/** Creates (no id) or updates an account; throws a short reason when refused. */
	save(input: AiAccountInput): AiAccountView {
		if (!input || typeof input !== "object" || !isAnyAccountProvider(input.provider)) {
			throw new Error("Invalid provider");
		}
		const name = clean(input.name, MAX_NAME);
		if (!name) throw new Error("A name is required");
		if (isLoginProvider(input.provider)) return this.saveLogin(input.provider, name, input.id);
		const typed = unmaskSecret(typeof input.apiKey === "string" ? input.apiKey : undefined);
		const apiKey = typed === undefined ? undefined : clean(typed, MAX_KEY + 1);
		if (apiKey !== undefined && apiKey.length > MAX_KEY) throw new Error("Key too long");
		if (apiKey !== undefined && /\s/.test(apiKey)) throw new Error("Invalid key");

		const file = this.read();
		const now = new Date().toISOString();
		if (input.id === undefined) {
			if (!apiKey) throw new Error("A key is required");
			if (file.accounts.length >= MAX_AI_ACCOUNTS) throw new Error("Too many accounts");
			const created: StoredAccount = {
				id: randomUUID(),
				provider: input.provider,
				name,
				apiKey: encryptSecret(apiKey),
				createdAt: now,
				keySetAt: now,
			};
			this.write({ ...file, accounts: [...file.accounts, created] });
			return viewOf(created);
		}

		const index = file.accounts.findIndex((account) => account.id === input.id);
		if (index < 0) throw new Error("Account not found");
		const existing = file.accounts[index];
		if (existing.provider !== input.provider) throw new Error("Invalid provider");
		const updated: StoredAccount = {
			...existing,
			name,
			...(apiKey ? { apiKey: encryptSecret(apiKey), keySetAt: now } : {}),
		};
		file.accounts[index] = updated;
		this.write(file);
		return viewOf(updated);
	}

	/** A CLI account: created with a folder of its own, then only renamed. */
	private saveLogin(provider: string, name: string, id: string | undefined): AiAccountView {
		const file = this.read();
		if (id === undefined) {
			if (file.accounts.length >= MAX_AI_ACCOUNTS) throw new Error("Too many accounts");
			const newId = randomUUID();
			const home = path.join(this.homesRoot, provider, newId);
			mkdirSync(home, { recursive: true, mode: 0o700 });
			const created: StoredAccount = { id: newId, provider, name, home, createdAt: new Date().toISOString() };
			this.write({ ...file, accounts: [...file.accounts, created] });
			return viewOf(created);
		}
		const existing = file.accounts.find((account) => account.id === id);
		if (!existing) throw new Error("Account not found");
		if (existing.provider !== provider) throw new Error("Invalid provider");
		existing.name = name;
		this.write(file);
		return viewOf(existing);
	}

	/** The folder of a CLI account, for its sign-in terminal. */
	homeOf(id: string): string | undefined {
		return this.read().accounts.find((account) => account.id === id)?.home;
	}

	/** Whether `home` is the folder of one of `provider`'s CLI accounts. */
	isLoginHome(provider: string, home: string): boolean {
		return this.read().accounts.some((account) => account.provider === provider && account.home === home);
	}

	/**
	 * Makes `id` the default account of `provider`; null goes back to the key
	 * typed on the provider's own page (a CLI: the sign-in of the system).
	 */
	setDefault(provider: string, id: string | null): void {
		if (!isAnyAccountProvider(provider)) throw new Error("Invalid provider");
		const file = this.read();
		if (id === null) {
			delete file.defaults[provider];
		} else {
			const account = file.accounts.find((candidate) => candidate.id === id);
			if (!account || account.provider !== provider) throw new Error("Account not found");
			if (isLoginProvider(provider)) {
				if (!viewOf(account).signedIn) throw new Error("This account is not signed in");
			} else if (!account.apiKey) {
				throw new Error("This account has no key");
			}
			file.defaults[provider] = id;
		}
		this.write(file);
	}

	/**
	 * Deletes an account, and a CLI account's folder with the sign-in in it; a
	 * provider whose default it was goes back to its main key.
	 */
	delete(id: string): boolean {
		const file = this.read();
		const accounts = file.accounts.filter((account) => account.id !== id);
		if (accounts.length === file.accounts.length) return false;
		const home = file.accounts.find((account) => account.id === id)?.home;
		if (home) rmSync(home, { recursive: true, force: true });
		const defaults = Object.fromEntries(
			Object.entries(file.defaults).filter(([, account]) => account !== id),
		);
		this.write({ accounts, defaults });
		return true;
	}
}

let defaultStore: AiAccountStore | null = null;

/** Where the app keeps its AI accounts (also primed at startup by `index.ts`). */
export function aiAccountsFilePath(): string {
	return path.join(app.getPath("userData"), "config", "ai-accounts.json");
}

/** The app's store, under `<userData>/config`. */
export function aiAccountStore(): AiAccountStore {
	defaultStore ??= new AiAccountStore(aiAccountsFilePath());
	return defaultStore;
}

/** Points the app's store at another file (tests). */
export function setAiAccountStoreForTests(store: AiAccountStore | null): void {
	defaultStore = store;
}
