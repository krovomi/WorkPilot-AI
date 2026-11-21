/**
 * The repository a git remote names on its forge, read from the remote URL.
 *
 * A project's forge settings say which repository its issues, pull requests
 * and pipelines come from. They used to be typed by hand (or copied from
 * another project by an old save race), so a project could show another
 * project's repository without anything noticing. The remote is the truth the
 * checkout already holds: these functions read it, host compared whole like
 * `git-remote-provider.ts` does, and return null for anything they do not
 * recognise rather than a guess.
 */

import { gitRemoteHost } from "./git-remote-provider";

/** The path part of `https://host/a/b.git`, `ssh://git@host:22/a/b` or `git@host:a/b`. */
export function gitRemotePath(url: string): string {
	const trimmed = url.trim();
	let rest: string;
	const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(trimmed);
	if (scheme) {
		rest = scheme[1] ?? "";
	} else {
		// scp-like syntax: [user@]host:path
		const scp = /^(?:[^@/]+@)?[^/:]+:(.*)$/.exec(trimmed);
		if (!scp) return "";
		rest = scp[1];
	}
	rest = rest.split(/[?#]/, 1)[0];
	return rest
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
}

function segments(path: string): string[] {
	return path.split("/").filter((part) => part.length > 0);
}

/** A path segment a forge could name: no `.`/`..`, no control or space. */
function isPlainSegment(segment: string): boolean {
	return (
		segment !== "." &&
		segment !== ".." &&
		/^[A-Za-z0-9._~%-]+$/.test(segment)
	);
}

/**
 * `owner/repo` as GitHub names them: the only form a repository reference may
 * take before it becomes part of an API path or a runner argument (no `..`,
 * no extra segment, no query, no leading `-`).
 */
export function isGitHubFullName(value: string): boolean {
	const match = /^[A-Za-z0-9][A-Za-z0-9-]*\/([A-Za-z0-9._-]+)$/.exec(value);
	return match !== null && match[1] !== "." && match[1] !== "..";
}

/** `owner/repo` for a github.com remote, else null. */
export function githubRepoOfRemote(url: string): string | null {
	const host = gitRemoteHost(url);
	if (host !== "github.com" && host !== "www.github.com") return null;
	const parts = segments(gitRemotePath(url));
	if (parts.length !== 2 || !parts.every(isPlainSegment)) return null;
	return `${parts[0]}/${parts[1]}`;
}

/**
 * `group/subgroup/project` for a remote on the GitLab instance whose host is
 * `instanceHost` (`gitlab.com` by default), else null.
 */
export function gitlabProjectOfRemote(
	url: string,
	instanceHost = "gitlab.com",
): string | null {
	const host = gitRemoteHost(url);
	const expected = instanceHost.trim().toLowerCase().split(":", 1)[0];
	if (!expected || host !== expected) return null;
	const parts = segments(gitRemotePath(url));
	if (parts.length < 2 || !parts.every(isPlainSegment)) return null;
	return parts.join("/");
}

export interface AzureRemoteRepo {
	/** `https://dev.azure.com/<org>` or `https://<org>.visualstudio.com`. */
	orgUrl: string;
	project: string;
	repository: string;
}

function decodeSegment(segment: string): string | null {
	try {
		const decoded = decodeURIComponent(segment);
		// A name, not a path: nothing that could step out of the URL it joins.
		for (const char of decoded) {
			if (char.charCodeAt(0) < 0x20 || char === "/" || char === "\\") return null;
		}
		return decoded === "." || decoded === ".." ? null : decoded;
	} catch {
		return null;
	}
}

/**
 * The organization, project and repository of an Azure DevOps remote:
 * `https://[org@]dev.azure.com/org/project/_git/repo`,
 * `git@ssh.dev.azure.com:v3/org/project/repo` and
 * `https://org.visualstudio.com/[DefaultCollection/]project/_git/repo`.
 */
export function azureRepoOfRemote(url: string): AzureRemoteRepo | null {
	const host = gitRemoteHost(url);
	const parts = segments(gitRemotePath(url));
	let org: string | undefined;
	let orgUrl: string;
	let rest: string[];
	if (host === "dev.azure.com") {
		if (parts.length !== 4 || parts[2] !== "_git") return null;
		org = parts[0];
		rest = [parts[1], parts[3]];
		orgUrl = `https://dev.azure.com/${org}`;
	} else if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
		if (parts.length !== 4 || parts[0] !== "v3") return null;
		org = parts[1];
		rest = [parts[2], parts[3]];
		orgUrl = `https://dev.azure.com/${org}`;
	} else if (host.endsWith(".visualstudio.com")) {
		org = host.slice(0, -".visualstudio.com".length);
		const withoutCollection =
			parts[0]?.toLowerCase() === "defaultcollection" ? parts.slice(1) : parts;
		if (withoutCollection.length !== 3 || withoutCollection[1] !== "_git") {
			return null;
		}
		rest = [withoutCollection[0], withoutCollection[2]];
		orgUrl = `https://${org}.visualstudio.com`;
	} else {
		return null;
	}
	if (!org || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) return null;
	const project = decodeSegment(rest[0]);
	const repository = decodeSegment(rest[1]);
	if (!project || !repository) return null;
	return { orgUrl, project, repository };
}
