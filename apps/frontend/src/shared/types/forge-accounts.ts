/**
 * Forge accounts: several GitHub, GitLab, Azure DevOps or Bitbucket accounts
 * saved once for the app, each project picking the one it works with
 * (`main/forge/forge-accounts.ts`). The renderer only ever sees whether an
 * account has a token, never the token.
 */

export const FORGE_KINDS = ["github", "gitlab", "azure_devops", "bitbucket"] as const;

export type ForgeKind = (typeof FORGE_KINDS)[number];

/** An account as the renderer sees it. */
export interface ForgeAccountView {
	id: string;
	forge: ForgeKind;
	/** The name the person gave it ("Work", "Client X"). */
	label: string;
	/**
	 * Where the token is valid: `https://github.com`, a GitLab instance
	 * origin, `https://dev.azure.com/<org>` (or `<org>.visualstudio.com`), or
	 * `https://bitbucket.org`.
	 */
	host: string;
	/** The forge login, when known (filled by a connection test). */
	username?: string;
	hasToken: boolean;
	createdAt: string;
}

/** What the renderer sends to create (no id) or update an account. */
export interface ForgeAccountInput {
	id?: string;
	forge: ForgeKind;
	label: string;
	host?: string;
	username?: string;
	/** A new token; the mask or nothing keeps the saved one. */
	token?: string;
}

export interface ForgeAccountTestResult {
	ok: boolean;
	/** The login the forge answered with. */
	username?: string;
	/** A short reason when `ok` is false (never the token, never the forge's raw body). */
	error?: string;
}
