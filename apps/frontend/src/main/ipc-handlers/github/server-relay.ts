/**
 * GitHub for a server project (server mode).
 *
 * A server project's issues and pull requests are read and changed through
 * the server (`shared_features/forge.py`), which calls GitHub with the token
 * the person stored there ("My tokens on the server"): the same token from
 * any computer, never this computer's `gh` login nor another person's token.
 *
 * The GitHub handlers keep their shape: `getGitHubConfig` gives a server
 * project a config whose `token` is a handle naming the project, not a
 * secret, and `githubFetch` sends a call made with such a handle to the
 * server instead of to GitHub. The repository is the server's
 * (`project.remote.repoUrl`), and the server checks every call against it.
 */

import type { Project } from "../../../shared/types";
import { authedFetch } from "../../server-connection";
import type { GitHubConfig } from "./types";

const HANDLE = "workpilot-server-project:";
const ERROR_BODY_MAX = 500;

/** `owner/repo` of a github.com clone URL, else null. */
export function githubRepoOf(repoUrl: string | undefined): string | null {
	const match =
		/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
			(repoUrl ?? "").trim(),
		);
	return match ? match[1] : null;
}

/** The config of a server project on GitHub; null for another forge. */
export function serverGitHubConfig(project: Project): GitHubConfig | null {
	// The forge the server lists, when it lists one (`server/forges.py`)
	const forge = project.remote?.forge;
	if (forge !== undefined && forge !== "github") return null;
	const repo = githubRepoOf(project.remote?.repoUrl);
	return repo ? { token: serverHandle(project.id), repo } : null;
}

/** Whether a config's token is a server project's handle. */
export function isServerHandle(token: string): boolean {
	return token.startsWith(HANDLE);
}

export interface RelayAnswer {
	status?: number;
	body?: unknown;
	text?: string;
	/** GitLab's `X-Total`, when it gave one. */
	total?: number;
}

/** The server project a handle names, made from `serverHandle`. */
export function serverHandle(projectId: string): string {
	return HANDLE + projectId;
}

/**
 * One call of a forge relay of the server (`github/read`, `gitlab/write`…)
 * for the project a handle names; a forge's error status is thrown as the
 * forge's own fetch throws it.
 */
export async function relayToServer(
	handle: string,
	route: `${"github" | "gitlab"}/${"read" | "write" | "pulls"}`,
	payload: Record<string, unknown>,
): Promise<RelayAnswer> {
	const projectId = handle.slice(HANDLE.length);
	const forge = route.startsWith("gitlab") ? "GitLab" : "GitHub";
	const result = await authedFetch<RelayAnswer>(
		`/api/features/forge/${route}?project_id=${encodeURIComponent(projectId)}`,
		"POST",
		payload,
	);
	if (!result.ok) throw new Error(result.error);
	const answer = result.data ?? {};
	const status = typeof answer.status === "number" ? answer.status : 502;
	if (status >= 400) {
		const detail = JSON.stringify(answer.body ?? answer.text ?? "").slice(
			0,
			ERROR_BODY_MAX,
		);
		throw new Error(`${forge} API error: ${status} - ${detail}`);
	}
	return answer;
}

function endpointOf(endpoint: string): string {
	return endpoint.startsWith("https://api.github.com/")
		? endpoint.slice("https://api.github.com".length)
		: endpoint;
}

/** `githubFetch` for a server project: the same call, made by the server. */
export async function relayGitHubFetch(
	handle: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<unknown> {
	const method = (options.method ?? "GET").toUpperCase();
	const body =
		typeof options.body === "string" && options.body
			? (JSON.parse(options.body) as unknown)
			: undefined;
	const answer = await relayToServer(handle, method === "GET" ? "github/read" : "github/write", {
		method,
		endpoint: endpointOf(endpoint),
		...(body === undefined ? {} : { body }),
	});
	return answer.body ?? null;
}

/** A pull request's diff, as text. */
export async function relayGitHubDiff(
	handle: string,
	repo: string,
	prNumber: number,
): Promise<string> {
	const answer = await relayToServer(handle, "github/read", {
		endpoint: `/repos/${repo}/pulls/${prNumber}`,
		accept: "diff",
	});
	return typeof answer.text === "string" ? answer.text : "";
}

/** A page of the project's open pull requests (GraphQL's answer). */
export async function relayOpenPulls<T>(
	handle: string,
	first: number,
	after: string | null,
): Promise<T> {
	const answer = await relayToServer(handle, "github/pulls", { first, after });
	const result = answer.body as T & { errors?: Array<{ message: string }> };
	if (!result || (result.errors && result.errors.length > 0)) {
		throw new Error("GitHub API request failed");
	}
	return result;
}
