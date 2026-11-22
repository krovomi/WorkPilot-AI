/**
 * Bitbucket's answers as the views see them. Everything here is external
 * text: typed, stripped of control characters and bounded before it crosses
 * to the renderer; a link is kept only when it is an https page of
 * bitbucket.org.
 */

import type {
	BitbucketComment,
	BitbucketDiffFile,
	BitbucketIssue,
	BitbucketPipeline,
	BitbucketPipelineStep,
	BitbucketPullRequest,
	BitbucketUser,
} from "../../../shared/types";
import { providerFromRemoteUrl } from "../../../shared/utils/git-remote-provider";
import { sanitizeText } from "../shared/sanitize";

/** A body or a comment as long as a view shows. */
export const MAX_BODY = 50_000;
const MAX_TITLE = 500;
const MAX_NAME = 200;

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
const text = (value: unknown, max = MAX_NAME) => sanitizeText(value, max);
const body = (value: unknown) => sanitizeText(value, MAX_BODY, true);
const num = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const optionalNum = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const date = (value: unknown) => {
	if (typeof value !== "string") return "";
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};
const optionalDate = (value: unknown) => date(value) || undefined;
/** The `raw` text of Bitbucket's rendered-content objects (`content`, `description`). */
const rawText = (value: unknown) => (typeof value === "string" ? value : obj(value).raw);

/** An https page of bitbucket.org (or a subdomain), else "". */
export function bitbucketWebUrl(value: unknown): string {
	if (typeof value !== "string") return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return providerFromRemoteUrl(url.toString()) === "bitbucket" ? url.toString() : "";
	} catch {
		return "";
	}
}

const htmlLink = (value: unknown) => bitbucketWebUrl(obj(obj(obj(value).links).html).href);

function user(value: unknown): BitbucketUser | undefined {
	const raw = obj(value);
	const displayName = text(raw.display_name) || text(raw.nickname);
	if (!displayName) return undefined;
	const nickname = text(raw.nickname);
	return { displayName, ...(nickname ? { nickname } : {}) };
}

export function toIssue(value: unknown): BitbucketIssue {
	const raw = obj(value);
	return {
		id: num(raw.id),
		title: sanitizeText(raw.title, MAX_TITLE),
		content: body(rawText(raw.content)),
		state: text(raw.state, 32) || "new",
		kind: text(raw.kind, 32),
		priority: text(raw.priority, 32),
		reporter: user(raw.reporter),
		assignee: user(raw.assignee),
		createdOn: date(raw.created_on),
		updatedOn: date(raw.updated_on),
		webUrl: htmlLink(raw),
	};
}

/** Bitbucket's open issue states; every other one is closed for the filter. */
export const OPEN_ISSUE_STATES = ["new", "open"] as const;

export function toComment(value: unknown): BitbucketComment {
	const raw = obj(value);
	const inline = obj(raw.inline);
	const path = text(inline.path, 1000);
	const line = num(inline.to) || num(inline.from);
	return {
		id: num(raw.id),
		content: body(rawText(raw.content)),
		author: user(raw.user),
		createdOn: date(raw.created_on),
		...(path ? { path } : {}),
		...(path && line ? { line } : {}),
	};
}

/** A comment Bitbucket still shows: deleted ones carry no text. */
export const isLiveComment = (value: unknown) => obj(value).deleted !== true;

export function toPullRequest(value: unknown): BitbucketPullRequest {
	const raw = obj(value);
	return {
		id: num(raw.id),
		title: sanitizeText(raw.title, MAX_TITLE),
		description: body(rawText(raw.description) ?? rawText(raw.summary)),
		state: text(raw.state, 32),
		draft: raw.draft === true,
		author: user(raw.author),
		sourceBranch: text(obj(obj(raw.source).branch).name, 255),
		destinationBranch: text(obj(obj(raw.destination).branch).name, 255),
		commentCount: num(raw.comment_count),
		createdOn: date(raw.created_on),
		updatedOn: date(raw.updated_on),
		webUrl: htmlLink(raw),
	};
}

export function toDiffFile(value: unknown): BitbucketDiffFile {
	const raw = obj(value);
	const newPath = text(obj(raw.new).path, 1000);
	const oldPath = text(obj(raw.old).path, 1000);
	return {
		path: newPath || oldPath,
		...(oldPath && oldPath !== newPath ? { oldPath } : {}),
		status: text(raw.status, 32),
		linesAdded: num(raw.lines_added),
		linesRemoved: num(raw.lines_removed),
	};
}

/** A pipeline's or a step's state: its result once completed, else its stage or state. */
export function pipelineState(value: unknown): string {
	const state = obj(value);
	const result = text(obj(state.result).name, 32);
	const stage = text(obj(state.stage).name, 32);
	return result || stage || text(state.name, 32) || "UNKNOWN";
}

export function toPipeline(value: unknown, repoWebUrl: string): BitbucketPipeline {
	const raw = obj(value);
	const buildNumber = num(raw.build_number);
	const branch = text(obj(raw.target).ref_name, 255);
	return {
		uuid: text(raw.uuid, 64),
		buildNumber,
		state: pipelineState(raw.state),
		...(branch ? { branch } : {}),
		createdOn: date(raw.created_on),
		completedOn: optionalDate(raw.completed_on),
		durationSeconds: optionalNum(raw.duration_in_seconds),
		webUrl: repoWebUrl && buildNumber ? `${repoWebUrl}/pipelines/results/${buildNumber}` : "",
	};
}

export function toPipelineStep(value: unknown): BitbucketPipelineStep {
	const raw = obj(value);
	return {
		uuid: text(raw.uuid, 64),
		name: text(raw.name) || "step",
		state: pipelineState(raw.state),
		startedOn: optionalDate(raw.started_on),
		completedOn: optionalDate(raw.completed_on),
		durationSeconds: optionalNum(raw.duration_in_seconds),
	};
}
