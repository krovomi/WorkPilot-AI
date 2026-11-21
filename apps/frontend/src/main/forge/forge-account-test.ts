/**
 * The connection test of a saved forge account, run in the main process: the
 * token is read from the store here and only goes to the address the account
 * was saved for (`forge-accounts.ts`). The renderer learns whether it worked,
 * the login the forge answered with, or a short reason: never the token,
 * never the forge's raw body.
 */

import type {
	ForgeAccountTestResult,
	ForgeAccountView,
} from "../../shared/types/forge-accounts";

const TIMEOUT_MS = 10_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Probe {
	url: string;
	headers: Record<string, string>;
	/** The login in the answer, when the answer says the token works. */
	login: (body: unknown) => string | undefined;
}

function field(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function basic(user: string, secret: string): string {
	return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
}

/** The request that tells whether `token` works for `account`, by forge. */
export function forgeAccountProbe(account: ForgeAccountView, token: string): Probe {
	switch (account.forge) {
		case "github":
			return {
				url: "https://api.github.com/user",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "WorkPilot-AI",
				},
				login: (body) => text(field(body, "login")),
			};
		case "gitlab":
			return {
				url: `${account.host}/api/v4/user`,
				headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
				login: (body) => text(field(body, "username")),
			};
		case "azure_devops":
			return {
				url: `${account.host}/_apis/connectionData`,
				headers: { Authorization: basic("", token), Accept: "application/json" },
				// A refused PAT answers 203 with a sign-in page, not JSON: no user.
				login: (body) =>
					text(field(body, "authenticatedUser", "properties", "Account", "$value")) ??
					text(field(body, "authenticatedUser", "providerDisplayName")),
			};
		case "bitbucket":
			return {
				url: "https://api.bitbucket.org/2.0/user",
				headers: {
					// Username + API token or app password: Basic; access token: Bearer.
					Authorization: account.username ? basic(account.username, token) : `Bearer ${token}`,
					Accept: "application/json",
				},
				login: (body) => text(field(body, "username")) ?? text(field(body, "nickname")),
			};
	}
}

/** Tries `token` against the forge of `account`. */
export async function testForgeAccount(
	account: ForgeAccountView,
	token: string | undefined,
	fetchImpl: Fetch = fetch,
): Promise<ForgeAccountTestResult> {
	if (!token) return { ok: false, error: "No token saved" };
	const probe = forgeAccountProbe(account, token);
	let response: Response;
	try {
		response = await fetchImpl(probe.url, {
			method: "GET",
			headers: probe.headers,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, error: "The forge could not be reached" };
	}
	if (response.status === 401 || response.status === 403) {
		return { ok: false, error: `Token refused (${response.status})` };
	}
	if (response.status !== 200) {
		return { ok: false, error: `Unexpected answer (${response.status})` };
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, error: "Token refused" };
	}
	const login = probe.login(body);
	if (!login) return { ok: false, error: "Token refused" };
	return { ok: true, username: login };
}
