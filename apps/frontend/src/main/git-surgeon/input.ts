/**
 * What the renderer may send to the Git History Surgeon (#360), checked here
 * before anything reaches the runner (S6): a revision of a known shape, a plan
 * whose steps hold shas, messages and paths only, branch names git accepts.
 * The runner checks the plan again against the repository itself.
 */

export const REVISION = /^[\w][\w./@^~{}-]{0,199}$/;
export const BRANCH = /^(?!-)(?!.*\.\.)[\w][\w./-]{0,199}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const KINDS = new Set(["keep", "reword", "squash", "split"]);
const MAX_STEPS = 1000;
const MAX_MESSAGE = 8000;
const MAX_PATHS = 5000;

export interface PlanInput {
	base: string;
	head: string;
	branch?: string;
	plan: { kind: string; sources: string[]; message: string; paths: string[] }[];
}

export function readRevision(value: unknown): string | null {
	return typeof value === "string" && REVISION.test(value) && !value.includes("..") ? value : null;
}

/** The plan to replay, or null when any part of it is not of the known shape. */
export function readPlanInput(raw: unknown): PlanInput | null {
	const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!data || typeof data.base !== "string" || !SHA.test(data.base)) return null;
	if (typeof data.head !== "string" || !SHA.test(data.head)) return null;
	if (data.branch !== undefined && (typeof data.branch !== "string" || !BRANCH.test(data.branch))) return null;
	if (!Array.isArray(data.plan) || data.plan.length === 0 || data.plan.length > MAX_STEPS) return null;
	const plan: PlanInput["plan"] = [];
	for (const item of data.plan) {
		const step = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
		if (!step || typeof step.kind !== "string" || !KINDS.has(step.kind)) return null;
		const sources = step.sources;
		if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_STEPS) return null;
		if (!sources.every((s) => typeof s === "string" && SHA.test(s))) return null;
		const message = step.message;
		if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE || message.includes("\0"))
			return null;
		const paths = step.paths ?? [];
		if (!Array.isArray(paths) || paths.length > MAX_PATHS) return null;
		if (!paths.every((p) => typeof p === "string" && p.length > 0 && p.length < 4096 && !p.includes("\0")))
			return null;
		plan.push({ kind: step.kind, sources: sources as string[], message, paths: paths as string[] });
	}
	return {
		base: data.base,
		head: data.head,
		...(typeof data.branch === "string" ? { branch: data.branch } : {}),
		plan,
	};
}

export function readBranchNames(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) return null;
	return raw.every((n) => typeof n === "string" && BRANCH.test(n)) ? (raw as string[]) : null;
}
