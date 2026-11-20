/**
 * What the CI/CD Triggers page may ask the main to run, checked before the
 * runner starts (rule S6): a provider among the four the runner knows, an
 * http(s) pull request URL, a branch and a workflow file that are plain names,
 * and a provider's run id (digits).
 */

import { isSafeBranch } from "../../shared/utils/task-stack";
import { RUN_ID } from "./deploy-watch";

export const CICD_PROVIDERS = ["github", "gitlab", "azure", "jenkins"] as const;

export interface TriggerParams {
	provider: string;
	pr_url?: string;
	branch?: string;
	workflow?: string;
}

const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_URL = 2048;
const DEFAULT_RUNS = 50;
const MAX_RUNS = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPullRequestUrl(value: string): boolean {
	if (value.length > MAX_URL) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** An optional text field: absent or empty is absent, anything else must pass `check`. */
function optional(value: unknown, check: (text: string) => boolean): string | undefined | null {
	if (value === undefined || value === null || value === "") return undefined;
	return typeof value === "string" && check(value) ? value : null;
}

/** The trigger request the page sent, or null when any field is not one. */
export function triggerParams(value: unknown): TriggerParams | null {
	if (!isPlainObject(value)) return null;
	const provider = value.provider;
	if (typeof provider !== "string" || !(CICD_PROVIDERS as readonly string[]).includes(provider)) {
		return null;
	}
	const pr_url = optional(value.pr_url, isPullRequestUrl);
	const branch = optional(value.branch, isSafeBranch);
	const workflow = optional(value.workflow, (text) => WORKFLOW.test(text));
	if (pr_url === null || branch === null || workflow === null) return null;
	return {
		provider,
		...(pr_url ? { pr_url } : {}),
		...(branch ? { branch } : {}),
		...(workflow ? { workflow } : {}),
	};
}

/** A provider's run id: digits only. */
export function isProviderRunId(value: unknown): value is string {
	return typeof value === "string" && RUN_ID.test(value);
}

/** How many runs to list: a whole number from 1 to 500, 50 otherwise. */
export function runsLimit(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_RUNS
		? (value as number)
		: DEFAULT_RUNS;
}
