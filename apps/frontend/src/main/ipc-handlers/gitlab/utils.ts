/**
 * GitLab utility functions: the project's GitLab config, the REST API, and
 * the host and token of the glab CLI.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { Project } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { getAugmentedEnv } from "../../env-utils";
import {
	getProjectEnvPath,
	readProjectEnvFileAsync,
} from "../../project-env-file";
import { isServerHandle } from "../github/server-relay";
import {
	relayGitLabFetch,
	relayGitLabFetchWithCount,
	serverGitLabConfig,
} from "./server-relay";
import type { GitLabConfig } from "./types";

const execFileAsync = promisify(execFile);

const DEFAULT_GITLAB_URL = "https://gitlab.com";
export const DEFAULT_GITLAB_HOST = "gitlab.com";

/** The origin of an http(s) instance URL without credentials, else null. */
function parseInstanceUrl(value: string): string | null {
	const candidate = value.trim();
	if (!candidate) return null;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return null;
		}
		if (parsed.username || parsed.password) return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

/** `value` without control characters and trimmed; null when nothing is left. */
function stripControl(value: string | undefined): string | null {
	if (!value) return null;
	let kept = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 0x1f && code !== 0x7f) kept += char;
	}
	return kept.trim() || null;
}

function sanitizeToken(value: string | undefined): string | null {
	return stripControl(value)?.substring(0, 512) ?? null;
}

// GitLab limits project paths to 255 chars, using 1024 as defense-in-depth
const MAX_PROJECT_REF_LENGTH = 1024;

function sanitizeProjectRef(value: string | undefined): string | null {
	const ref = stripControl(value);
	return ref && ref.length <= MAX_PROJECT_REF_LENGTH ? ref : null;
}

/**
 * The host glab names an instance by, from what the renderer sends: nothing
 * (gitlab.com), a host with an optional port and path (`gitlab.acme.dev`,
 * the settings page strips the scheme) or an http(s) URL. Null for anything
 * else, a URL with credentials or a host that could read as an option.
 */
export function glabHost(value: unknown): string | null {
	if (value === undefined || value === "") return DEFAULT_GITLAB_HOST;
	if (typeof value !== "string") return null;
	const url = value.includes("://") ? value : `https://${value}`;
	const origin = parseInstanceUrl(url);
	if (!origin) return null;
	const host = new URL(origin).host;
	return /^[a-z0-9]/.test(host) ? host : null;
}

/** The `--hostname` argument of a glab command, none for gitlab.com. */
export function glabHostArgs(host: string): string[] {
	return host === DEFAULT_GITLAB_HOST ? [] : [`--hostname=${host}`];
}

/** Runs glab by its resolved path, without a shell. */
export async function runGlab(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(getToolPath("glab"), args, {
		encoding: "utf-8",
		env: getAugmentedEnv(),
	});
	return stdout;
}

/** The token glab holds for `host`, or null when it has none. */
export async function getGlabToken(host: string): Promise<string | null> {
	try {
		return sanitizeToken(
			await runGlab(["auth", "token", ...glabHostArgs(host)]),
		);
	} catch {
		return null;
	}
}

// GitLab environment variable keys (must match env-handlers.ts)
const GITLAB_ENV_KEYS = {
	ENABLED: "GITLAB_ENABLED",
	TOKEN: "GITLAB_TOKEN",
	INSTANCE_URL: "GITLAB_INSTANCE_URL",
	PROJECT: "GITLAB_PROJECT",
} as const;

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get GitLab configuration from project environment file
 * Falls back to glab CLI token if GITLAB_TOKEN not in .env
 * Returns null if GitLab is explicitly disabled via GITLAB_ENABLED=false.
 * A project set as a clone URL (`https://gitlab.com/group/app.git`) is
 * reduced to its path, which the API endpoints take.
 */
export async function getGitLabConfig(
	project: Project,
): Promise<GitLabConfig | null> {
	// A server project's calls go through the server (`server-relay.ts`).
	if (project.remote) return serverGitLabConfig(project);
	const envPath = getProjectEnvPath(project);
	if (!envPath || !(await fileExists(envPath))) return null;

	try {
		const vars = await readProjectEnvFileAsync(envPath);
		if (vars[GITLAB_ENV_KEYS.ENABLED]?.toLowerCase() === "false") {
			return null;
		}

		const instanceUrl = parseInstanceUrl(
			vars[GITLAB_ENV_KEYS.INSTANCE_URL] || DEFAULT_GITLAB_URL,
		);
		if (!instanceUrl) return null;
		const ref = sanitizeProjectRef(vars[GITLAB_ENV_KEYS.PROJECT]);
		const projectRef = ref && normalizeProjectReference(ref, instanceUrl);
		const token =
			sanitizeToken(vars[GITLAB_ENV_KEYS.TOKEN]) ??
			(await getGlabToken(new URL(instanceUrl).host));

		if (!token || !projectRef) return null;
		return { token, instanceUrl, project: projectRef };
	} catch {
		return null;
	}
}

/**
 * Normalize a GitLab project reference to group/project format
 * Handles:
 * - group/project (already normalized)
 * - group/subgroup/project (nested groups)
 * - https://gitlab.com/group/project
 * - https://gitlab.com/group/project.git
 * - git@gitlab.com:group/project.git
 * - Numeric project ID (returns as-is)
 */
export function normalizeProjectReference(
	project: string,
	instanceUrl: string = DEFAULT_GITLAB_URL,
): string {
	if (!project) return "";

	// If it's a numeric ID, return as-is
	if (/^\d+$/.test(project)) {
		return project;
	}

	// Remove trailing .git if present
	let normalized = project.replace(/\.git$/, "");

	// Extract hostname for comparison
	let gitlabHostname: string;
	try {
		gitlabHostname = new URL(instanceUrl).hostname;
	} catch {
		gitlabHostname = DEFAULT_GITLAB_HOST;
	}

	// Escape special regex characters in hostname to prevent ReDoS
	const escapedHostname = gitlabHostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	// Handle full GitLab URLs
	const httpsPattern = new RegExp(`^https?://${escapedHostname}/`);
	if (httpsPattern.test(normalized)) {
		normalized = normalized.replace(httpsPattern, "");
	} else if (normalized.startsWith(`git@${gitlabHostname}:`)) {
		normalized = normalized.replace(`git@${gitlabHostname}:`, "");
	}

	return normalized.trim();
}

/**
 * URL-encode a project path for GitLab API
 * GitLab API requires project paths to be URL-encoded (e.g., group%2Fproject)
 */
export function encodeProjectPath(projectPath: string): string {
	// If it's a numeric ID, return as-is
	if (/^\d+$/.test(projectPath)) {
		return projectPath;
	}
	return encodeURIComponent(projectPath);
}

// Default timeout for GitLab API requests (30 seconds)
const GITLAB_API_TIMEOUT_MS = 30000;

/** One REST call: the response once it is OK, with its parsed body. */
async function request(
	token: string,
	instanceUrl: string,
	endpoint: string,
	options: RequestInit,
): Promise<{ response: Response; data: unknown }> {
	const baseUrl = parseInstanceUrl(instanceUrl);
	if (!baseUrl) {
		throw new Error("Invalid GitLab instance URL");
	}
	if (!endpoint.startsWith("/")) {
		throw new Error("GitLab endpoint must be a relative path");
	}
	const url = `${baseUrl}/api/v4${endpoint}`;
	const safeToken = sanitizeToken(token);
	if (!safeToken) {
		throw new Error("Invalid GitLab token");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), GITLAB_API_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				...options.headers,
				"PRIVATE-TOKEN": safeToken,
			},
		});
		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`GitLab API error: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}
		return { response, data: await response.json() };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`GitLab API timeout after ${GITLAB_API_TIMEOUT_MS / 1000}s: ${url}`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Make a request to the GitLab API with timeout. */
export async function gitlabFetch(
	token: string,
	instanceUrl: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<unknown> {
	if (isServerHandle(token)) return relayGitLabFetch(token, endpoint, options);
	return (await request(token, instanceUrl, endpoint, options)).data;
}

/**
 * A request to the GitLab API with the total count of a paginated endpoint
 * (its `X-Total` header; 0 when it has none, or not a number).
 */
export async function gitlabFetchWithCount(
	token: string,
	instanceUrl: string,
	endpoint: string,
	options: RequestInit = {},
): Promise<{ data: unknown; totalCount: number }> {
	if (isServerHandle(token)) {
		return relayGitLabFetchWithCount(token, endpoint, options);
	}
	const { response, data } = await request(token, instanceUrl, endpoint, options);
	const totalCount = Number.parseInt(response.headers.get("X-Total") ?? "", 10);
	return { data, totalCount: Number.isNaN(totalCount) ? 0 : totalCount };
}
