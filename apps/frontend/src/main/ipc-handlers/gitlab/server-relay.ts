/**
 * GitLab for a server project (server mode), as `github/server-relay.ts` is
 * for GitHub: the project's issues and merge requests are read and changed
 * through the server (`shared_features/forge_gitlab.py`), with the GitLab
 * token the person stored there, on an instance the server's operator named.
 *
 * `getGitLabConfig` gives a server project the server's instance and path,
 * and a handle for a token; `gitlabFetch` sends a call made with the handle
 * to the server. Only a project the server lists as on GitLab gets one.
 */

import type { Project } from "../../../shared/types";
import { relayToServer, serverHandle } from "../github/server-relay";
import type { GitLabConfig } from "./types";

/** The instance URL and project path of a GitLab clone URL, else null. */
export function gitlabProjectOf(
	repoUrl: string | undefined,
): { instanceUrl: string; project: string } | null {
	const match =
		/^(?:https:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]{1,253})\/|git@([A-Za-z0-9.-]{1,253}):|ssh:\/\/git@([A-Za-z0-9.-]{1,253})(?::\d{1,5})?\/)([A-Za-z0-9_.-]{1,255}(?:\/[A-Za-z0-9_.-]{1,255}){1,19})\/?$/.exec(
			(repoUrl ?? "").trim(),
		);
	if (!match) return null;
	const host = (match[1] ?? match[2] ?? match[3]).toLowerCase();
	const project = match[4].replace(/\.git$/, "");
	if (project.split("/").some((part) => ["", ".", ".."].includes(part))) {
		return null;
	}
	return { instanceUrl: `https://${host}`, project };
}

/** The config of a server project on GitLab; null for any other. */
export function serverGitLabConfig(project: Project): GitLabConfig | null {
	if (project.remote?.forge !== "gitlab") return null;
	const found = gitlabProjectOf(project.remote.repoUrl);
	return found ? { token: serverHandle(project.id), ...found } : null;
}

function call(endpoint: string, options: RequestInit) {
	const method = (options.method ?? "GET").toUpperCase();
	const body =
		typeof options.body === "string" && options.body
			? (JSON.parse(options.body) as unknown)
			: undefined;
	return {
		route: method === "GET" ? ("gitlab/read" as const) : ("gitlab/write" as const),
		payload: { method, endpoint, ...(body === undefined ? {} : { body }) },
	};
}

/** `gitlabFetch` for a server project: the same call, made by the server. */
export async function relayGitLabFetch(
	handle: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<unknown> {
	const { route, payload } = call(endpoint, options);
	const answer = await relayToServer(handle, route, payload);
	return answer.body ?? null;
}

/** `gitlabFetchWithCount` for a server project. */
export async function relayGitLabFetchWithCount(
	handle: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<{ data: unknown; totalCount: number }> {
	const { route, payload } = call(endpoint, options);
	const answer = await relayToServer(handle, route, payload);
	return { data: answer.body ?? null, totalCount: typeof answer.total === "number" ? answer.total : 0 };
}
