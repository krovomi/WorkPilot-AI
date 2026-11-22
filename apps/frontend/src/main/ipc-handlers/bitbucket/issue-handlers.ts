/**
 * The Bitbucket issue tracker of a project: whether the project reaches its
 * repository, the issues (a repository with the tracker turned off answers
 * `issuesEnabled: false`, not an error), an issue's comments, and the import
 * of issues as tasks. Arguments are checked by `ipc-guard.ts` first.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	BitbucketImportResult,
	BitbucketIssue,
	BitbucketIssueFilter,
	BitbucketIssueList,
	BitbucketSyncStatus,
	IPCResult,
} from "../../../shared/types";
import { projectStore } from "../../project-store";
import { bitbucketIpcMain } from "./ipc-guard";
import { errorMessage, NOT_CONFIGURED, withBitbucketProject } from "./project-bitbucket";
import { buildBitbucketIssueContext, createSpecForBitbucketIssue } from "./spec-utils";
import {
	bitbucketWebUrl,
	isLiveComment,
	OPEN_ISSUE_STATES,
	toComment,
	toIssue,
} from "./transform";
import {
	BitbucketApiError,
	type BitbucketConfig,
	bitbucketFetch,
	bitbucketFetchAll,
	getBitbucketConfig,
	repoPath,
} from "./utils";

const OPEN_QUERY = OPEN_ISSUE_STATES.map((s) => `state="${s}"`).join(" OR ");

/** The `q` filter of an issue list (Bitbucket's query language), from a closed list. */
export function issueQuery(filter: BitbucketIssueFilter): string {
	if (filter === "all") return "";
	const q = filter === "open" ? OPEN_QUERY : `NOT (${OPEN_QUERY})`;
	return `&q=${encodeURIComponent(q)}`;
}

/** A 404 on the issue endpoints: the repository's tracker is off (or never was). */
const trackerOff = (error: unknown) => error instanceof BitbucketApiError && error.status === 404;

async function issueComments(config: BitbucketConfig, id: number) {
	const raw = await bitbucketFetchAll<unknown>(
		config,
		`${repoPath(config)}/issues/${id}/comments?pagelen=100&sort=created_on`,
	);
	return raw.filter(isLiveComment).map(toComment).filter((c) => c.content);
}

async function checkConnection(projectId: string): Promise<IPCResult<BitbucketSyncStatus>> {
	const project = projectStore.getProject(projectId);
	if (!project) return { success: false, error: "Project not found" };
	const config = await getBitbucketConfig(project);
	if (!config) return { success: true, data: { connected: false, error: NOT_CONFIGURED } };
	try {
		const repo = (await bitbucketFetch(config, repoPath(config))) as {
			full_name?: unknown;
			description?: unknown;
			has_issues?: unknown;
			links?: { html?: { href?: unknown } };
		};
		return {
			success: true,
			data: {
				connected: true,
				workspace: config.workspace,
				repo: config.repo,
				fullName: typeof repo.full_name === "string" ? repo.full_name.slice(0, 300) : `${config.workspace}/${config.repo}`,
				description: typeof repo.description === "string" ? repo.description.slice(0, 2000) : "",
				hasIssues: repo.has_issues === true,
				webUrl: bitbucketWebUrl(repo.links?.html?.href),
			},
		};
	} catch (error) {
		return {
			success: true,
			data: {
				connected: false,
				error: errorMessage(error, "Failed to connect to Bitbucket"),
			},
		};
	}
}

export function registerBitbucketIssueHandlers(): void {
	bitbucketIpcMain.handle(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, (_event, projectId: string) =>
		checkConnection(projectId),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_ISSUES,
		(_event, projectId: string, filter: BitbucketIssueFilter = "open") =>
			withBitbucketProject(projectId, "get issues", async (config): Promise<BitbucketIssueList> => {
				try {
					const raw = await bitbucketFetchAll<unknown>(
						config,
						`${repoPath(config)}/issues?pagelen=50&sort=-updated_on${issueQuery(filter)}`,
					);
					return { issuesEnabled: true, issues: raw.map(toIssue) };
				} catch (error) {
					if (trackerOff(error)) return { issuesEnabled: false, issues: [] };
					throw error;
				}
			}),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS,
		(_event, projectId: string, id: number) =>
			withBitbucketProject(projectId, "get comments", (config) => issueComments(config, id)),
	);

	bitbucketIpcMain.handle(
		IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES,
		(_event, projectId: string, ids: number[]) =>
			withBitbucketProject(projectId, "import issues", async (config, project) => {
				const result: BitbucketImportResult = { success: false, imported: 0, failed: 0 };
				const errors: string[] = [];
				for (const id of new Set(ids)) {
					try {
						const issue: BitbucketIssue = toIssue(
							await bitbucketFetch(config, `${repoPath(config)}/issues/${id}`),
						);
						const comments = await issueComments(config, id);
						const context = buildBitbucketIssueContext(
							issue,
							`${config.workspace}/${config.repo}`,
							comments,
						);
						await createSpecForBitbucketIssue(project, issue, context, project.settings?.mainBranch);
						result.imported++;
					} catch (error) {
						result.failed++;
						errors.push(`#${id}: ${errorMessage(error, "Unknown error")}`);
					}
				}
				result.success = result.imported > 0;
				if (errors.length > 0) result.errors = errors;
				return result;
			}),
	);
}
