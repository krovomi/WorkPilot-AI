/**
 * GitHub utility functions
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Project } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { getAugmentedEnv } from "../../env-utils";
import { getProjectEnvPath, readProjectEnvFile } from "../../project-env-file";
import { isServerHandle, relayGitHubFetch, serverGitHubConfig } from "./server-relay";
import type { GitHubConfig } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Get GitHub token from gh CLI if available (async to avoid blocking main thread)
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
async function getTokenFromGhCliAsync(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			getToolPath("gh"),
			["auth", "token"],
			{
				encoding: "utf-8",
				env: getAugmentedEnv(),
			},
		);
		const token = stdout.trim();
		return token || null;
	} catch {
		return null;
	}
}

/**
 * Get GitHub token from gh CLI if available (sync version for getGitHubConfig)
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
function getTokenFromGhCliSync(): string | null {
	try {
		const token = execFileSync(getToolPath("gh"), ["auth", "token"], {
			encoding: "utf-8",
			stdio: "pipe",
			env: getAugmentedEnv(),
		}).trim();
		return token || null;
	} catch {
		return null;
	}
}

/**
 * Get a fresh GitHub token for subprocess use (async to avoid blocking main thread)
 * Always fetches fresh from gh CLI - no caching to ensure account changes are reflected
 * @returns The current GitHub token or null if not authenticated
 */
export async function getGitHubTokenForSubprocess(): Promise<string | null> {
	return getTokenFromGhCliAsync();
}

/**
 * Get GitHub configuration from project environment file, the repository as
 * `owner/repo` whatever form it was saved in.
 * Falls back to gh CLI token if GITHUB_TOKEN not in .env.
 * A server project's calls go through the server (`server-relay.ts`).
 */
export function getGitHubConfig(project: Project): GitHubConfig | null {
	if (project.remote) return serverGitHubConfig(project);
	const envPath = getProjectEnvPath(project);
	if (!envPath || !existsSync(envPath)) return null;

	// Neither reading the file nor asking gh throws: each answers "nothing".
	const vars = readProjectEnvFile(envPath);
	// Saved as typed: a clone URL becomes the `owner/repo` of every API path.
	const repo = normalizeRepoReference(vars.GITHUB_REPO ?? "");
	// If no token in .env, try to get it from gh CLI (sync version for sync function)
	const token = vars.GITHUB_TOKEN || getTokenFromGhCliSync();
	if (!token || !repo) return null;
	return { token, repo };
}

/**
 * Normalize a GitHub repository reference to owner/repo format
 * Handles:
 * - owner/repo (already normalized)
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
export function normalizeRepoReference(repo: string): string {
	if (!repo) return "";

	// Remove trailing .git if present
	let normalized = repo.replace(/\.git$/, "");

	// Handle full GitHub URLs
	if (normalized.startsWith("https://github.com/")) {
		normalized = normalized.replace("https://github.com/", "");
	} else if (normalized.startsWith("http://github.com/")) {
		normalized = normalized.replace("http://github.com/", "");
	} else if (normalized.startsWith("git@github.com:")) {
		normalized = normalized.replace("git@github.com:", "");
	}

	return normalized.trim();
}

/**
 * `owner/repo` as GitHub names them: the only form a repository reference may
 * take before it becomes part of an API path (no `..`, no extra segment, no
 * query).
 */
export function isRepoFullName(value: string): boolean {
	const match = /^[A-Za-z0-9-]+\/([A-Za-z0-9._-]+)$/.exec(value);
	return match !== null && match[1] !== "." && match[1] !== "..";
}

/**
 * Make a request to the GitHub API
 */
export async function githubFetch(
	token: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<unknown> {
	if (isServerHandle(token)) return relayGitHubFetch(token, endpoint, options);
	const url = endpoint.startsWith("http")
		? endpoint
		: `https://api.github.com${endpoint}`;

	const response = await fetch(url, {
		...options,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "WorkPilot-AI",
			...options.headers,
		},
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`GitHub API error: ${response.status} ${response.statusText} - ${errorBody}`,
		);
	}

	return response.json();
}

/**
 * An issue or pull request number received from the renderer: a positive
 * whole number, or null. It becomes part of an API path, so nothing else may
 * pass.
 */
export function issueNumberArg(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}
