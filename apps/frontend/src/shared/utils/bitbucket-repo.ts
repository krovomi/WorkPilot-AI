/**
 * A Bitbucket Cloud repository named the ways a person types it: a workspace
 * and a slug apart, `workspace/repo`, or a clone URL
 * (`https://user@bitbucket.org/ws/repo.git`, `git@bitbucket.org:ws/repo.git`,
 * `ssh://git@bitbucket.org/ws/repo.git`). Both parts end up in an API path,
 * so each is held to Bitbucket's slug characters; anything else is refused
 * rather than encoded.
 */

import { gitRemoteHost, providerFromRemoteUrl } from "./git-remote-provider";

export interface BitbucketRepoRef {
	workspace: string;
	repo: string;
}

/** Bitbucket slugs: letters, digits, `-`, `_`, `.`; never a dot path, never an option. */
const SLUG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function isBitbucketSlug(value: unknown): value is string {
	return typeof value === "string" && SLUG.test(value) && !/^\.+$/.test(value);
}

/** The `workspace/repo` path of a bitbucket.org remote, or null. */
export function bitbucketRepoFromRemote(url: string): BitbucketRepoRef | null {
	const trimmed = url.trim();
	if (providerFromRemoteUrl(trimmed) !== "bitbucket") return null;
	const host = gitRemoteHost(trimmed);
	const at = trimmed.toLowerCase().indexOf(host);
	// What follows the host: `:ws/repo.git`, `:22/ws/repo`, `/ws/repo.git`.
	const rest = trimmed
		.slice(at + host.length)
		.replace(/^:\d+(?=\/)/, "")
		.replace(/^[:/]+/, "")
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	return splitRef(rest);
}

function splitRef(value: string): BitbucketRepoRef | null {
	const parts = value.split("/");
	if (parts.length !== 2) return null;
	const [workspace, repo] = parts;
	return isBitbucketSlug(workspace) && isBitbucketSlug(repo) ? { workspace, repo } : null;
}

/**
 * The repository a project's settings name: `repo` may be a slug (with
 * `workspace` beside it), `workspace/repo` or a clone URL. Null when it
 * names none.
 */
export function normalizeBitbucketRepo(
	workspace: string | undefined,
	repo: string | undefined,
): BitbucketRepoRef | null {
	const ref = (repo ?? "").trim();
	const ws = (workspace ?? "").trim();
	if (!ref) return null;
	if (ref.includes("://") || ref.includes("@")) return bitbucketRepoFromRemote(ref);
	if (ref.includes("/")) return splitRef(ref.replace(/\.git$/, ""));
	return isBitbucketSlug(ws) && isBitbucketSlug(ref) ? { workspace: ws, repo: ref } : null;
}
