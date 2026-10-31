/**
 * What the PR view does to a pull request with `gh` on this computer: read
 * its diff, comment, merge, bring its branch up to date. A server project
 * (server mode) has no clone here, so the same action is a call of GitHub's
 * API made through the server with the person's own token
 * (`server-relay.ts`). Split out of pr-handlers.ts, at its size cap.
 */

import { execFile, execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Project } from "../../../shared/types";
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
	// Arguments array, no shell: nothing in it is interpreted
	return execFileSync("gh", ["pr", "diff", String(prNumber)], {
		cwd: project.path,
		encoding: "utf-8",
		env: getAugmentedEnv(),
	});
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
	// A temp file avoids any escaping of the body
	const tmpFile = join(project.path, ".workpilot", "tmp_comment_body.txt");
	try {
		writeFileSync(tmpFile, body, "utf-8");
		execFileSync("gh", ["pr", "comment", String(prNumber), "--body-file", tmpFile], {
			cwd: project.path,
			env: getAugmentedEnv(),
		});
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Already gone, or never written
		}
	}
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
	execFileSync("gh", ["pr", "merge", String(prNumber), `--${mergeMethod}`], {
		cwd: project.path,
		env: getAugmentedEnv(),
	});
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
	await promisify(execFile)("gh", ["pr", "update-branch", String(prNumber)], {
		cwd: project.path,
		env: getAugmentedEnv(),
	});
}
