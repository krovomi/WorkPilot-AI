/**
 * What the PR view does to a pull request with `gh` on this computer: read
 * its diff, comment, merge, bring its branch up to date. A server project
 * (server mode) has no clone here, so the same action is a call of GitHub's
 * API made through the server with the person's own token
 * (`server-relay.ts`). Split out of pr-handlers.ts, at its size cap.
 */

import { execFile } from "node:child_process";
import type { Project } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { getAugmentedEnv } from "../../env-utils";
import { relayGitHubDiff } from "./server-relay";
import { getGitHubConfig, githubFetch } from "./utils";

export type MergeMethod = "merge" | "squash" | "rebase";
const MERGE_METHODS: readonly string[] = ["merge", "squash", "rebase"];

function checkNumber(prNumber: number): void {
	// Validated before it reaches an argument list or a URL
	if (!Number.isInteger(prNumber) || prNumber <= 0) {
		throw new Error("Invalid PR number");
	}
}

/** Room for the diff of a large PR (execFile keeps 1 MB by default). */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs `gh` in the project's clone, by its path and an argument list (no
 * shell), without blocking the main process; `input` goes to its stdin.
 * Rejects with gh's error, its stderr included.
 */
function runGh(project: Project, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			getToolPath("gh"),
			args,
			{ cwd: project.path, env: getAugmentedEnv(), encoding: "utf-8", maxBuffer: MAX_OUTPUT },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
		child.stdin?.end(input);
	});
}

/** The repository and handle of a server project on GitHub. */
function serverConfig(project: Project) {
	const config = getGitHubConfig(project);
	if (!config) throw new Error("Not a GitHub project");
	return config;
}

export async function prDiff(project: Project, prNumber: number): Promise<string> {
	checkNumber(prNumber);
	if (project.remote) {
		const config = serverConfig(project);
		return relayGitHubDiff(config.token, config.repo, prNumber);
	}
	return runGh(project, ["pr", "diff", String(prNumber)]);
}

export async function prComment(
	project: Project,
	prNumber: number,
	body: string,
): Promise<void> {
	checkNumber(prNumber);
	if (project.remote) {
		const config = serverConfig(project);
		await githubFetch(config.token, `/repos/${config.repo}/issues/${prNumber}/comments`, {
			method: "POST",
			body: JSON.stringify({ body }),
		});
		return;
	}
	// The body on stdin: no escaping, and no file a second comment would share
	await runGh(project, ["pr", "comment", String(prNumber), "--body-file", "-"], body);
}

export async function prMerge(
	project: Project,
	prNumber: number,
	mergeMethod: MergeMethod,
): Promise<void> {
	checkNumber(prNumber);
	if (!MERGE_METHODS.includes(mergeMethod)) {
		throw new Error("Invalid merge method");
	}
	if (project.remote) {
		const config = serverConfig(project);
		await githubFetch(config.token, `/repos/${config.repo}/pulls/${prNumber}/merge`, {
			method: "PUT",
			body: JSON.stringify({ merge_method: mergeMethod }),
		});
		return;
	}
	await runGh(project, ["pr", "merge", String(prNumber), `--${mergeMethod}`]);
}

/** Merge the base branch into the PR's branch (never a rebase, so no force push). */
export async function prUpdateBranch(project: Project, prNumber: number): Promise<void> {
	checkNumber(prNumber);
	if (project.remote) {
		const config = serverConfig(project);
		await githubFetch(
			config.token,
			`/repos/${config.repo}/pulls/${prNumber}/update-branch`,
			{ method: "PUT", body: JSON.stringify({}) },
		);
		return;
	}
	await runGh(project, ["pr", "update-branch", String(prNumber)]);
}
