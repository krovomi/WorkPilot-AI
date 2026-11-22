/**
 * Bitbucket Cloud from the main process: a project's config (its
 * `.workpilot/.env`, token decrypted, never handed to the renderer) and the
 * REST API at https://api.bitbucket.org/2.0 — the only host a request or a
 * pagination `next` link may reach. Auth: HTTP Basic `username:token` (API
 * token or app password), or Bearer when no username is set (workspace or
 * repository access token).
 */

import type { Project } from "../../../shared/types";
import { normalizeBitbucketRepo } from "../../../shared/utils/bitbucket-repo";
import { withForgeAccounts } from "../../forge/forge-credentials";
import { getProjectEnvPath, readProjectEnvFileAsync } from "../../project-env-file";
import { BITBUCKET_ENV_KEYS, readBitbucketEnvConfig } from "./env-config";

export const BITBUCKET_API_ORIGIN = "https://api.bitbucket.org";
const API_BASE = `${BITBUCKET_API_ORIGIN}/2.0`;
const TIMEOUT_MS = 30_000;
/** Pages followed at most for one list (Bitbucket pages are 10 to 100 items). */
export const MAX_PAGES = 5;
/** A token or username longer than this is not one. */
const MAX_CREDENTIAL = 1024;
/** Bitbucket's error text is cut before it reaches a message. */
const MAX_ERROR_TEXT = 300;

export interface BitbucketConfig {
	workspace: string;
	repo: string;
	username?: string;
	token: string;
}

/** `value` without control characters and trimmed; undefined when nothing is left or too long. */
function credential(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let kept = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 0x1f && code !== 0x7f) kept += char;
	}
	kept = kept.trim();
	return kept && kept.length <= MAX_CREDENTIAL ? kept : undefined;
}

/** The config the `.env` variables name, or null when Bitbucket is off or incomplete. */
export function bitbucketConfigFromEnv(vars: Record<string, string>): BitbucketConfig | null {
	const fields = readBitbucketEnvConfig(vars);
	if (!fields.bitbucketEnabled) return null;
	const token = credential(vars[BITBUCKET_ENV_KEYS.TOKEN]);
	const ref = normalizeBitbucketRepo(fields.bitbucketWorkspace, fields.bitbucketRepo);
	if (!token || !ref) return null;
	const username = credential(vars[BITBUCKET_ENV_KEYS.USERNAME]);
	return { ...ref, token, ...(username ? { username } : {}) };
}

/**
 * A local project's Bitbucket config, with the saved account it names
 * (`forge-credentials.ts`); a server project has none (no relay for Bitbucket).
 */
export async function getBitbucketConfig(project: Project): Promise<BitbucketConfig | null> {
	if (project.remote) return null;
	const envPath = getProjectEnvPath(project);
	if (!envPath) return null;
	return bitbucketConfigFromEnv(withForgeAccounts(await readProjectEnvFileAsync(envPath)));
}

export function authorizationHeader(config: Pick<BitbucketConfig, "username" | "token">): string {
	if (config.username) {
		return `Basic ${Buffer.from(`${config.username}:${config.token}`).toString("base64")}`;
	}
	return `Bearer ${config.token}`;
}

/** Bitbucket's pipeline uuid, braces included: `{8-4-4-4-12}` hex. */
export const isPipelineUuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^\{[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}$/.test(value);

/** `/repositories/<workspace>/<repo>`, both slugs already checked. */
export function repoPath(config: Pick<BitbucketConfig, "workspace" | "repo">): string {
	return `/repositories/${encodeURIComponent(config.workspace)}/${encodeURIComponent(config.repo)}`;
}

/** Whether `url` is on the API host, over https, without credentials or another port. */
export function isBitbucketApiUrl(url: unknown): url is string {
	if (typeof url !== "string") return false;
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === BITBUCKET_API_ORIGIN &&
			!parsed.username &&
			!parsed.password &&
			parsed.pathname.startsWith("/2.0/")
		);
	} catch {
		return false;
	}
}

/** A failed call: the HTTP status (0 for the network) and Bitbucket's own message, bounded. */
export class BitbucketApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "BitbucketApiError";
	}
}

async function errorText(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: unknown } };
		const message = body?.error?.message;
		if (typeof message === "string") return message.slice(0, MAX_ERROR_TEXT);
	} catch {
		// Not JSON: the status says enough.
	}
	return response.statusText;
}

/** The URL of an API path (`/repositories/…`) or of a `next` link; refused off the API host. */
function requestUrl(pathOrUrl: string): string {
	const url = pathOrUrl.startsWith("/") ? `${API_BASE}${pathOrUrl}` : pathOrUrl;
	if (pathOrUrl.startsWith("//") || !isBitbucketApiUrl(url)) {
		throw new BitbucketApiError(0, "Refused a request outside api.bitbucket.org");
	}
	return url;
}

/** Redirects followed at most (a pull request's diff answers with one). */
const MAX_REDIRECTS = 2;

/**
 * One call to the API; JSON by default, text with `as: "text"` (a diff). A
 * redirect is followed by hand, and only to the API host: the token never
 * goes anywhere else.
 */
export async function bitbucketFetch(
	config: Pick<BitbucketConfig, "username" | "token">,
	pathOrUrl: string,
	init: { method?: "GET" | "POST"; body?: unknown; as?: "json" | "text" } = {},
): Promise<unknown> {
	let url = requestUrl(pathOrUrl);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		let response: Response;
		for (let hop = 0; ; hop++) {
			response = await fetch(url, {
				method: init.method ?? "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: {
					Accept: init.as === "text" ? "text/plain" : "application/json",
					Authorization: authorizationHeader(config),
					...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			});
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) break;
			const target = new URL(location, url).toString();
			if (hop >= MAX_REDIRECTS || !isBitbucketApiUrl(target)) {
				throw new BitbucketApiError(response.status, "Refused a redirect outside api.bitbucket.org");
			}
			url = target;
		}
		if (!response.ok) {
			throw new BitbucketApiError(
				response.status,
				`Bitbucket API error ${response.status}: ${await errorText(response)}`,
			);
		}
		return init.as === "text" ? await response.text() : await response.json();
	} catch (error) {
		if (error instanceof BitbucketApiError) throw error;
		const timedOut = error instanceof Error && error.name === "AbortError";
		throw new BitbucketApiError(
			0,
			timedOut ? "Bitbucket API timeout" : "Bitbucket API unreachable",
		);
	} finally {
		clearTimeout(timer);
	}
}

interface Page<T> {
	values?: T[];
	next?: unknown;
}

/** Every item of a paginated list, up to `maxPages`; a `next` off the API host ends the list. */
export async function bitbucketFetchAll<T>(
	config: Pick<BitbucketConfig, "username" | "token">,
	path: string,
	maxPages = MAX_PAGES,
): Promise<T[]> {
	const items: T[] = [];
	let next: string | undefined = path;
	for (let page = 0; next && page < maxPages; page++) {
		const body = (await bitbucketFetch(config, next)) as Page<T>;
		items.push(...(Array.isArray(body?.values) ? body.values : []));
		next = isBitbucketApiUrl(body?.next) ? body.next : undefined;
	}
	return items;
}
