/**
 * Which repository a project's forge settings point at, checked against the
 * remotes of its own checkout.
 *
 * Every forge view (issues, pull requests, merge requests, pipelines, the PR
 * review runners) reads the repository from the project's `.workpilot/.env`.
 * That value was typed by hand, or — before `useProjectEnvConfig` bound a
 * save to its project — copied from another project: a project with no
 * GitHub remote at all was found holding `GITHUB_REPO=krovomi/WorkPilot-AI`.
 * Nothing compared it with the checkout, so the views of several projects
 * showed one repository.
 *
 * Here the remotes are the reference. An empty setting takes the repository
 * of the project's remote (`detectedGitHubRepo`, `detectedGitLabProject`), and
 * a saved one that matches none of the project's remotes is reported as a
 * mismatch, with the remotes' repositories as fixes the settings page offers.
 * Nothing is rewritten without the person: a fork may legitimately track an
 * upstream it has no remote for.
 */

import { execFileSync } from "node:child_process";
import type { ProjectEnvConfig } from "../../shared/types";
import type {
	ForgeBinding,
	ForgeBindingCandidate,
	ProjectForgeBindings,
} from "../../shared/types/forge-binding";
import {
	azureRepoOfRemote,
	githubRepoOfRemote,
	gitlabProjectOfRemote,
} from "../../shared/utils/git-remote-repo";
import { getToolPath } from "../cli-tool-manager";

export interface GitRemote {
	name: string;
	url: string;
}

const REMOTE_CACHE_MS = 5000;
const remoteCache = new Map<string, { at: number; remotes: GitRemote[] }>();

/** Parses `git remote -v`: one entry per remote (its fetch URL), origin first. */
export function parseGitRemoteList(output: string): GitRemote[] {
	const byName = new Map<string, { fetch?: string; push?: string }>();
	for (const line of output.split(/\r?\n/)) {
		const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
		if (!match) continue;
		const entry = byName.get(match[1]) ?? {};
		entry[match[3] as "fetch" | "push"] = match[2];
		byName.set(match[1], entry);
	}
	const remotes: GitRemote[] = [];
	for (const [name, urls] of byName) {
		const url = urls.fetch ?? urls.push;
		if (url) remotes.push({ name, url });
	}
	return remotes.sort((a, b) =>
		a.name === "origin" ? -1 : b.name === "origin" ? 1 : 0,
	);
}

/** The project's remotes; none when it is not a git checkout. Cached briefly. */
export function listGitRemotes(projectPath: string): GitRemote[] {
	const cached = remoteCache.get(projectPath);
	if (cached && Date.now() - cached.at < REMOTE_CACHE_MS) return cached.remotes;
	let remotes: GitRemote[] = [];
	try {
		const output = execFileSync(getToolPath("git"), ["remote", "-v"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		remotes = parseGitRemoteList(output);
	} catch {
		remotes = [];
	}
	remoteCache.set(projectPath, { at: Date.now(), remotes });
	return remotes;
}

/** Forgets the cached remotes (after the remote was changed from the app). */
export function forgetGitRemotes(projectPath?: string): void {
	if (projectPath) remoteCache.delete(projectPath);
	else remoteCache.clear();
}

function unique(values: Array<string | null>): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value.toLowerCase())) continue;
		seen.add(value.toLowerCase());
		kept.push(value);
	}
	return kept;
}

/** `owner/repo` of the project's first GitHub remote (origin first), or null. */
export function detectedGitHubRepo(remotes: GitRemote[]): string | null {
	return unique(remotes.map((remote) => githubRepoOfRemote(remote.url)))[0] ?? null;
}

/** Path of the project's first remote on the GitLab instance at `instanceHost`. */
export function detectedGitLabProject(
	remotes: GitRemote[],
	instanceHost: string,
): string | null {
	return (
		unique(remotes.map((remote) => gitlabProjectOfRemote(remote.url, instanceHost)))[0] ??
		null
	);
}

function bindingOf(
	saved: string | null,
	candidates: ForgeBindingCandidate[],
	hasRemotes: boolean,
	matches: (candidate: ForgeBindingCandidate) => boolean,
	unverifiable = false,
): ForgeBinding {
	if (!saved) {
		return { status: candidates.length > 0 ? "detected" : "none", saved: null, candidates };
	}
	if (unverifiable || !hasRemotes) return { status: "unverified", saved, candidates };
	if (candidates.some(matches)) return { status: "matched", saved, candidates };
	return { status: "mismatch", saved, candidates };
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** GitHub: `GITHUB_REPO` against the project's github.com remotes. */
export function githubBinding(savedRepo: string, remotes: GitRemote[]): ForgeBinding {
	const saved = savedRepo.trim() || null;
	const candidates = unique(remotes.map((remote) => githubRepoOfRemote(remote.url))).map(
		(repo): ForgeBindingCandidate => ({ label: repo, fix: { githubRepo: repo } }),
	);
	return bindingOf(saved, candidates, remotes.length > 0, (candidate) =>
		sameName(candidate.label, saved ?? ""),
	);
}

/** GitLab: `GITLAB_PROJECT` against the remotes on the configured instance. */
export function gitlabBinding(
	savedProject: string,
	instanceHost: string,
	remotes: GitRemote[],
): ForgeBinding {
	const saved = savedProject.trim() || null;
	const candidates = unique(
		remotes.map((remote) => gitlabProjectOfRemote(remote.url, instanceHost)),
	).map((path): ForgeBindingCandidate => ({ label: path, fix: { gitlabProject: path } }));
	// A numeric project id names no path to compare with.
	const numeric = saved !== null && /^\d+$/.test(saved);
	return bindingOf(
		saved,
		candidates,
		remotes.length > 0,
		(candidate) => sameName(candidate.label, saved ?? ""),
		numeric,
	);
}

function azureOrgName(orgUrl: string): string {
	try {
		const url = new URL(orgUrl.trim());
		const host = url.hostname.toLowerCase();
		if (host === "dev.azure.com") return url.pathname.split("/").filter(Boolean)[0] ?? "";
		if (host.endsWith(".visualstudio.com")) return host.slice(0, -".visualstudio.com".length);
	} catch {
		// not a URL: nothing to compare
	}
	return "";
}

/** Azure DevOps: organization, project and repository against the remotes. */
export function azureDevOpsBinding(
	config: Pick<
		ProjectEnvConfig,
		"azureDevOpsOrgUrl" | "azureDevOpsProject" | "azureDevOpsRepository"
	>,
	remotes: GitRemote[],
): ForgeBinding {
	const project = config.azureDevOpsProject?.trim() ?? "";
	const repository = config.azureDevOpsRepository?.trim() ?? "";
	const org = azureOrgName(config.azureDevOpsOrgUrl ?? "");
	const saved = project || repository ? [org, project, repository].filter(Boolean).join("/") : null;
	const seen = new Set<string>();
	const candidates: ForgeBindingCandidate[] = [];
	for (const remote of remotes) {
		const repo = azureRepoOfRemote(remote.url);
		if (!repo) continue;
		const label = `${azureOrgName(repo.orgUrl)}/${repo.project}/${repo.repository}`;
		if (seen.has(label.toLowerCase())) continue;
		seen.add(label.toLowerCase());
		candidates.push({
			label,
			fix: {
				azureDevOpsOrgUrl: repo.orgUrl,
				azureDevOpsProject: repo.project,
				azureDevOpsRepository: repo.repository,
			},
		});
	}
	return bindingOf(saved, candidates, remotes.length > 0, (candidate) => {
		const fix = candidate.fix;
		return (
			(!org || sameName(azureOrgName(fix.azureDevOpsOrgUrl ?? ""), org)) &&
			(!project || sameName(fix.azureDevOpsProject ?? "", project)) &&
			(!repository || sameName(fix.azureDevOpsRepository ?? "", repository))
		);
	});
}

/** The three forges' bindings of one project, from its settings and its remotes. */
export function projectForgeBindings(
	vars: Record<string, string>,
	remotes: GitRemote[],
	normalize: { githubRepo: (value: string) => string; gitlabProject: (value: string, instanceUrl: string) => string },
): ProjectForgeBindings {
	const instanceUrl = vars.GITLAB_INSTANCE_URL?.trim() || "https://gitlab.com";
	let instanceHost = "gitlab.com";
	try {
		instanceHost = new URL(instanceUrl).hostname.toLowerCase();
	} catch {
		// keep gitlab.com
	}
	return {
		github: githubBinding(normalize.githubRepo(vars.GITHUB_REPO ?? ""), remotes),
		gitlab: gitlabBinding(
			normalize.gitlabProject(vars.GITLAB_PROJECT ?? "", instanceUrl),
			instanceHost,
			remotes,
		),
		azureDevOps: azureDevOpsBinding(
			{
				azureDevOpsOrgUrl: vars.AZURE_DEVOPS_ORG_URL,
				azureDevOpsProject: vars.AZURE_DEVOPS_PROJECT,
				azureDevOpsRepository: vars.AZURE_DEVOPS_REPOSITORY,
			},
			remotes,
		),
	};
}
