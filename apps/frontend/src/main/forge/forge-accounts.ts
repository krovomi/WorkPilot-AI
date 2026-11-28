/**
 * The forge accounts saved for the whole app: several GitHub, GitLab, Azure
 * DevOps and Bitbucket accounts, each with the host its token is valid for.
 * A project names the one it uses (`<FORGE>_ACCOUNT_ID` in its
 * `.workpilot/.env`) and `forge-credentials.ts` lends that account's token to
 * the readers of the project's forge settings.
 *
 * `<userData>/config/forge-accounts.json`, written whole (temporary file then
 * rename), mode 0600; each token is stored as `secret-storage.ts` decides
 * (`enc:` with a keyring). Only the main process reads it: the renderer gets
 * `ForgeAccountView`, which says whether a token is set and nothing more
 * (rule S6), and a token kept behind the mask only stays with the host it was
 * saved for.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
	FORGE_KINDS,
	type ForgeAccountInput,
	type ForgeAccountView,
	type ForgeKind,
} from "../../shared/types/forge-accounts";
import { decryptSecret, encryptSecret } from "../secret-storage";
import { unmaskSecret } from "../utils/masked-secret";

export const MAX_FORGE_ACCOUNTS = 50;
const MAX_LABEL = 80;
const MAX_USERNAME = 100;
const MAX_TOKEN = 4096;

interface StoredAccount {
	id: string;
	forge: ForgeKind;
	label: string;
	host: string;
	username?: string;
	/** As written to disk: `enc:` ciphertext, or clear without a keyring. */
	token?: string;
	createdAt: string;
}

/** Hosts whose token works for one fixed address. */
const FIXED_HOSTS: Partial<Record<ForgeKind, string>> = {
	github: "https://github.com",
	bitbucket: "https://bitbucket.org",
};

export function isForgeKind(value: unknown): value is ForgeKind {
	return typeof value === "string" && (FORGE_KINDS as readonly string[]).includes(value);
}

function clean(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	let kept = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 0x1f && code !== 0x7f) kept += char;
	}
	return kept.trim().slice(0, max);
}

/**
 * The address an account's token is valid for, normalized: the fixed one of
 * GitHub and Bitbucket, the origin of a GitLab instance (gitlab.com by
 * default), `https://dev.azure.com/<org>` or `https://<org>.visualstudio.com`.
 * Throws for anything else, a URL with credentials included.
 */
export function normalizeForgeHost(forge: ForgeKind, host: unknown): string {
	const fixed = FIXED_HOSTS[forge];
	if (fixed) return fixed;
	const raw = clean(host, 512) || (forge === "gitlab" ? "https://gitlab.com" : "");
	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw : `https://${raw}`);
	} catch {
		throw new Error("Invalid address");
	}
	if (url.username || url.password) throw new Error("Invalid address");
	if (forge === "gitlab") {
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid address");
		return url.origin;
	}
	// Azure DevOps: an organization.
	if (url.protocol !== "https:") throw new Error("Invalid address");
	const hostname = url.hostname.toLowerCase();
	if (hostname === "dev.azure.com") {
		const org = url.pathname.split("/").filter(Boolean)[0] ?? "";
		if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) throw new Error("Invalid address");
		return `https://dev.azure.com/${org}`;
	}
	if (/^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/.test(hostname)) return `https://${hostname}`;
	throw new Error("Invalid address");
}

function isStoredAccount(value: unknown): value is StoredAccount {
	if (!value || typeof value !== "object") return false;
	const account = value as Record<string, unknown>;
	return (
		typeof account.id === "string" &&
		isForgeKind(account.forge) &&
		typeof account.label === "string" &&
		typeof account.host === "string" &&
		(account.token === undefined || typeof account.token === "string") &&
		(account.username === undefined || typeof account.username === "string")
	);
}

export class ForgeAccountStore {
	constructor(private readonly filePath: string) {}

	private read(): StoredAccount[] {
		if (!existsSync(this.filePath)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as { accounts?: unknown };
			return Array.isArray(parsed.accounts) ? parsed.accounts.filter(isStoredAccount) : [];
		} catch {
			return [];
		}
	}

	private write(accounts: StoredAccount[]): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporary, this.filePath);
	}

	list(): ForgeAccountView[] {
		return this.read().map(({ token, ...account }) => ({
			...account,
			hasToken: Boolean(token),
		}));
	}

	get(id: string): ForgeAccountView | undefined {
		return this.list().find((account) => account.id === id);
	}

	/** The account's token in clear, or undefined (none, or not decryptable now). */
	tokenOf(id: string): string | undefined {
		const stored = this.read().find((account) => account.id === id)?.token;
		return stored ? decryptSecret(stored) : undefined;
	}

	/** Creates (no id) or updates an account; throws a short reason when refused. */
	save(input: ForgeAccountInput): ForgeAccountView {
		if (!input || typeof input !== "object" || !isForgeKind(input.forge)) {
			throw new Error("Invalid forge");
		}
		const label = clean(input.label, MAX_LABEL);
		if (!label) throw new Error("A name is required");
		const username = clean(input.username, MAX_USERNAME);
		if (username && !/^[A-Za-z0-9._@+-]+$/.test(username)) throw new Error("Invalid username");
		const host = normalizeForgeHost(input.forge, input.host);
		const typed = unmaskSecret(typeof input.token === "string" ? input.token : undefined);
		const token = typed === undefined ? undefined : clean(typed, MAX_TOKEN + 1);
		if (token !== undefined && token.length > MAX_TOKEN) throw new Error("Token too long");

		const accounts = this.read();
		if (input.id === undefined) {
			if (accounts.length >= MAX_FORGE_ACCOUNTS) throw new Error("Too many accounts");
			const created: StoredAccount = {
				id: randomUUID(),
				forge: input.forge,
				label,
				host,
				...(username ? { username } : {}),
				...(token ? { token: encryptSecret(token) } : {}),
				createdAt: new Date().toISOString(),
			};
			this.write([...accounts, created]);
			return this.get(created.id) as ForgeAccountView;
		}

		const index = accounts.findIndex((account) => account.id === input.id);
		if (index < 0) throw new Error("Account not found");
		const existing = accounts[index];
		if (existing.forge !== input.forge) throw new Error("Invalid forge");
		// A token kept behind the mask stays with the address it was saved for.
		if (token === undefined && existing.token && existing.host !== host) {
			throw new Error("Enter the token again for the new address");
		}
		const updated: StoredAccount = {
			...existing,
			label,
			host,
			username: username || undefined,
			token: token === undefined ? existing.token : token ? encryptSecret(token) : undefined,
		};
		accounts[index] = updated;
		this.write(accounts);
		return this.get(updated.id) as ForgeAccountView;
	}

	/** Records the login a connection test answered with. */
	setUsername(id: string, username: string): void {
		const cleaned = clean(username, MAX_USERNAME);
		if (!cleaned || !/^[A-Za-z0-9._@+-]+$/.test(cleaned)) return;
		const accounts = this.read();
		const account = accounts.find((candidate) => candidate.id === id);
		if (!account || account.username === cleaned) return;
		account.username = cleaned;
		this.write(accounts);
	}

	delete(id: string): boolean {
		const accounts = this.read();
		const kept = accounts.filter((account) => account.id !== id);
		if (kept.length === accounts.length) return false;
		this.write(kept);
		return true;
	}
}

let defaultStore: ForgeAccountStore | null = null;

/** Where the app keeps its forge accounts (also primed at startup by `index.ts`). */
export function forgeAccountsFilePath(): string {
	return path.join(app.getPath("userData"), "config", "forge-accounts.json");
}

/** The app's store, under `<userData>/config`. */
export function forgeAccountStore(): ForgeAccountStore {
	defaultStore ??= new ForgeAccountStore(forgeAccountsFilePath());
	return defaultStore;
}

/** Points the app's store at another file (tests). */
export function setForgeAccountStoreForTests(store: ForgeAccountStore | null): void {
	defaultStore = store;
}
