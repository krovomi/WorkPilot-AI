/**
 * Whether a task's pull request is open, merged or closed, on its forge.
 *
 * The URL comes from the task's metadata, which an agent writes: it is
 * matched against one shape per forge before anything reads it, and reaches
 * `gh` and `glab` as one argv entry (rules S4 and 6). Azure DevOps is read
 * over REST with the project's token from `.workpilot/.env`, sent in the
 * request header only, never logged. An answer that cannot be read is
 * "unknown", never "merged": a false merge would close a card.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project } from "../shared/types";
import { appLog } from "./app-logger";
import { getToolPath } from "./cli-tool-manager";
import { readProjectEnv } from "./project-env-file";

const execute = promisify(execFile);

export type PrState = "open" | "merged" | "closed" | "unknown";
export type PrForge = "github" | "gitlab" | "azure";

const GITHUB = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const GITLAB = /^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9_.\-/]+?)\/-\/merge_requests\/(\d+)$/;
const AZURE =
	/^https:\/\/dev\.azure\.com\/([A-Za-z0-9_.-]+)\/([^/?#\s]+)\/_git\/([^/?#\s]+)\/pullrequest\/(\d+)$/;
const TIMEOUT_MS = 30_000;

export function forgeOf(url: unknown): PrForge | null {
	if (typeof url !== "string" || url.length > 500) return null;
	const clean = url.replace(/\/+$/, "");
	if (AZURE.test(clean)) return "azure";
	if (GITLAB.test(clean)) return "gitlab";
	if (GITHUB.test(clean)) return "github";
	return null;
}

/** GitHub's `state` (`OPEN`, `MERGED`, `CLOSED`), GitLab's (`opened`, `merged`, `closed`, `locked`) and Azure's `status` (`active`, `completed`, `abandoned`). */
export function normalizePrState(raw: unknown): PrState {
	switch (typeof raw === "string" ? raw.toLowerCase() : "") {
		case "open":
		case "opened":
		case "active":
		case "locked":
			return "open";
		case "merged":
		case "completed":
			return "merged";
		case "closed":
		case "abandoned":
			return "closed";
		default:
			return "unknown";
	}
}

function field(stdout: string, key: string): unknown {
	try {
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		return parsed && typeof parsed === "object" ? parsed[key] : undefined;
	} catch {
		return undefined;
	}
}

async function run(tool: "gh" | "glab", args: string[], cwd: string): Promise<string> {
	const { stdout } = await execute(getToolPath(tool), args, {
		cwd,
		encoding: "utf-8",
		windowsHide: true,
		timeout: TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout;
}

async function azureState(url: string, project: Project): Promise<PrState> {
	const match = AZURE.exec(url);
	const token = readProjectEnv(project).AZURE_DEVOPS_PAT;
	if (!match || !token) return "unknown";
	const [, org, name, repo, id] = match;
	const api = `https://dev.azure.com/${org}/${name}/_apis/git/repositories/${repo}/pullrequests/${id}?api-version=7.1`;
	const response = await fetch(api, {
		headers: {
			Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) return "unknown";
	const body = (await response.json()) as Record<string, unknown>;
	return normalizePrState(body?.status);
}

/** The state of the PR at `url`; "unknown" when the forge did not say. */
export async function readPrState(url: string, project: Project): Promise<PrState> {
	const clean = url.replace(/\/+$/, "");
	const forge = forgeOf(clean);
	try {
		if (forge === "github") {
			const out = await run("gh", ["pr", "view", clean, "--json", "state"], project.path);
			return normalizePrState(field(out, "state"));
		}
		if (forge === "gitlab") {
			const [, host, repo, iid] = GITLAB.exec(clean) as RegExpExecArray;
			const out = await run(
				"glab",
				[
					"api",
					"--hostname",
					host,
					`projects/${encodeURIComponent(repo)}/merge_requests/${iid}`,
				],
				project.path,
			);
			return normalizePrState(field(out, "state"));
		}
		if (forge === "azure") return await azureState(clean, project);
	} catch (error) {
		appLog.debug(
			`[PR_STATE] ${forge} did not answer: ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
		);
	}
	return "unknown";
}
