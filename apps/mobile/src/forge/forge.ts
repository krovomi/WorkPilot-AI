/**
 * One adapter per forge over the server's relay: the calls the desktop's
 * views make (the server refuses any other), mapped to the shapes of
 * `types.ts`. A forge's own error (its status in the relay's answer) is
 * raised as an `ApiError` with that status, so the screens say it as they
 * say the server's.
 */

import { ApiError, type ServerClient } from "../api/client";
import type { FeatureJob, FeatureJobOutput } from "../features/types";
import type {
	ForgeComment,
	ForgeFile,
	ForgeIssue,
	ForgeKind,
	ForgePull,
	ForgeReview,
	ReviewFinding,
} from "./types";

const enc = encodeURIComponent;
type Json = Record<string, unknown>;

interface Relayed {
	status: number;
	body?: unknown;
}

/** `owner/name` (GitHub) or `group/sub/name` (GitLab) from a clone URL. */
export function repoPath(repoUrl: string): string | null {
	const url = repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
	const match = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?[^/:]+(?::\d+)?[:/](.+)$/.exec(url);
	const path = match?.[1] ?? null;
	if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) return null;
	return path.split("/").length >= 2 ? path : null;
}

const str = (v: unknown, max = 100_000): string => (typeof v === "string" ? v.slice(0, max) : "");
const opt = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const login = (v: unknown): string | null => opt(obj(v).login) ?? opt(obj(v).username);

export interface Forge {
	kind: ForgeKind;
	issues(): Promise<ForgeIssue[]>;
	issue(n: number): Promise<ForgeIssue>;
	issueComments(n: number): Promise<ForgeComment[]>;
	/** GitLab's relay takes no issue note: only GitHub comments on issues. */
	canCommentIssues: boolean;
	commentIssue(n: number, body: string): Promise<void>;
	pulls(): Promise<ForgePull[]>;
	pull(n: number): Promise<ForgePull>;
	pullFiles(n: number): Promise<ForgeFile[]>;
	pullComments(n: number): Promise<ForgeComment[]>;
	commentPull(n: number, body: string): Promise<void>;
	merge(n: number): Promise<void>;
	/** The pull's checks, summed up: GitHub only. */
	checks(sha: string): Promise<{ passed: number; failed: number; pending: number } | null>;
	reviews(numbers: number[]): Promise<Record<string, ForgeReview | null>>;
	startReview(n: number, followup: boolean): Promise<FeatureJob>;
	reviewJob(jobId: string, after?: number): Promise<FeatureJobOutput>;
}

export function makeForge(client: ServerClient, projectId: string, kind: ForgeKind, repoUrl: string): Forge | null {
	const path = repoPath(repoUrl);
	if (!path) return null;
	const q = `?project_id=${enc(projectId)}`;
	const relay = async (method: string, endpoint: string, body?: unknown): Promise<unknown> => {
		const route = method === "GET" ? "read" : "write";
		const answer = await client.request<Relayed>("POST", `/api/features/forge/${kind}/${route}${q}`, {
			method,
			endpoint,
			...(body !== undefined ? { body } : {}),
		});
		if (answer.status < 200 || answer.status >= 300) {
			const message = str(obj(answer.body).message, 300) || `${kind} ${answer.status}`;
			throw new ApiError(answer.status, message);
		}
		return answer.body;
	};
	const reviewsBase = `/api/features/forge/${kind}/reviews`;
	const common = {
		kind,
		reviews: async (numbers: number[]) => {
			if (!numbers.length) return {};
			const answer = await client.request<{ reviews: Record<string, string | null> }>(
				"GET",
				`${reviewsBase}${q}&numbers=${numbers.join(",")}`,
			);
			const out: Record<string, ForgeReview | null> = {};
			for (const [n, text] of Object.entries(answer.reviews)) out[n] = readReview(text);
			return out;
		},
		startReview: (n: number, followup: boolean) =>
			client.request<FeatureJob>("POST", `${reviewsBase}/jobs${q}`, { number: n, followup }),
		reviewJob: (jobId: string, after = 0) =>
			client.request<FeatureJobOutput>("GET", `${reviewsBase}/jobs/${enc(jobId)}${q}&after=${after}`),
	};
	return kind === "github" ? github(relay, client, q, path, common) : gitlab(relay, path, common);
}

type Relay = (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
type Common = Pick<Forge, "kind" | "reviews" | "startReview" | "reviewJob">;

function github(relay: Relay, client: ServerClient, q: string, path: string, common: Common): Forge {
	const repo = `/repos/${path}`;
	const issue = (i: Json): ForgeIssue => ({
		number: num(i.number) ?? 0,
		title: str(i.title, 500),
		body: str(i.body),
		state: str(i.state, 20),
		author: login(i.user),
		createdAt: opt(i.created_at),
		comments: num(i.comments),
		url: opt(i.html_url),
	});
	const comment = (c: Json): ForgeComment => ({
		id: String(c.id ?? ""),
		author: login(c.user),
		body: str(c.body),
		createdAt: opt(c.created_at),
	});
	const comments = async (n: number) =>
		list(await relay("GET", `${repo}/issues/${n}/comments?per_page=100`)).map(comment);
	const post = async (n: number, body: string) => {
		await relay("POST", `${repo}/issues/${n}/comments`, { body });
	};
	return {
		...common,
		canCommentIssues: true,
		// GitHub lists pull requests among issues: they are left out here.
		issues: async () =>
			list(await relay("GET", `${repo}/issues?state=open&per_page=50`))
				.filter((i) => !i.pull_request)
				.map(issue),
		issue: async (n) => issue(obj(await relay("GET", `${repo}/issues/${n}`))),
		issueComments: comments,
		commentIssue: post,
		pulls: async () => {
			const answer = await client.request<Relayed>("POST", `/api/features/forge/github/pulls${q}`, { first: 50 });
			if (answer.status !== 200) throw new ApiError(answer.status, `github ${answer.status}`);
			const nodes = list(obj(obj(obj(obj(answer.body).data).repository).pullRequests).nodes);
			return nodes.map((p) => ({
				number: num(p.number) ?? 0,
				title: str(p.title, 500),
				body: str(p.body),
				state: str(p.state, 20).toLowerCase(),
				author: login(p.author),
				head: opt(p.headRefName),
				base: opt(p.baseRefName),
				additions: num(p.additions),
				deletions: num(p.deletions),
				updatedAt: opt(p.updatedAt),
				url: opt(p.url),
			}));
		},
		pull: async (n) => {
			const p = obj(await relay("GET", `${repo}/pulls/${n}`));
			return {
				number: num(p.number) ?? n,
				title: str(p.title, 500),
				body: str(p.body),
				state: p.merged ? "merged" : str(p.state, 20),
				author: login(p.user),
				head: opt(obj(p.head).ref),
				base: opt(obj(p.base).ref),
				additions: num(p.additions),
				deletions: num(p.deletions),
				updatedAt: opt(p.updated_at),
				url: opt(p.html_url),
				headSha: opt(obj(p.head).sha),
				mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null,
			};
		},
		pullFiles: async (n) =>
			list(await relay("GET", `${repo}/pulls/${n}/files?per_page=100`)).map((f) => ({
				path: str(f.filename, 1_000),
				additions: num(f.additions),
				deletions: num(f.deletions),
				patch: opt(f.patch),
			})),
		pullComments: comments,
		commentPull: post,
		merge: async (n) => {
			await relay("PUT", `${repo}/pulls/${n}/merge`, {});
		},
		checks: async (sha) => {
			if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return null;
			const runs = list(obj(await relay("GET", `${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs);
			const sum = { passed: 0, failed: 0, pending: 0 };
			for (const run of runs) {
				if (run.status !== "completed") sum.pending++;
				else if (["success", "neutral", "skipped"].includes(String(run.conclusion))) sum.passed++;
				else sum.failed++;
			}
			return sum;
		},
	};
}

function gitlab(relay: Relay, path: string, common: Common): Forge {
	const project = `/projects/${enc(path)}`;
	const issue = (i: Json): ForgeIssue => ({
		number: num(i.iid) ?? 0,
		title: str(i.title, 500),
		body: str(i.description),
		state: str(i.state, 20),
		author: login(i.author),
		createdAt: opt(i.created_at),
		comments: num(i.user_notes_count),
		url: opt(i.web_url),
	});
	const note = (c: Json): ForgeComment => ({
		id: String(c.id ?? ""),
		author: login(c.author),
		body: str(c.body),
		createdAt: opt(c.created_at),
	});
	const mr = (p: Json): ForgePull => ({
		number: num(p.iid) ?? 0,
		title: str(p.title, 500),
		body: str(p.description),
		state: str(p.state, 20),
		author: login(p.author),
		head: opt(p.source_branch),
		base: opt(p.target_branch),
		additions: null,
		deletions: null,
		updatedAt: opt(p.updated_at),
		url: opt(p.web_url),
		mergeable: typeof p.merge_status === "string" ? p.merge_status === "can_be_merged" : null,
	});
	const userNotes = (v: unknown) => list(v).filter((c) => !c.system).map(note);
	return {
		...common,
		canCommentIssues: false,
		issues: async () => list(await relay("GET", `${project}/issues?state=opened&per_page=50`)).map(issue),
		issue: async (n) => issue(obj(await relay("GET", `${project}/issues/${n}`))),
		issueComments: async (n) => userNotes(await relay("GET", `${project}/issues/${n}/notes?per_page=100`)),
		commentIssue: async () => {
			throw new ApiError(403, "Not a call of the GitLab views");
		},
		pulls: async () => list(await relay("GET", `${project}/merge_requests?state=opened&per_page=50`)).map(mr),
		pull: async (n) => mr(obj(await relay("GET", `${project}/merge_requests/${n}`))),
		pullFiles: async (n) =>
			list(obj(await relay("GET", `${project}/merge_requests/${n}/changes`)).changes).map((f) => ({
				path: str(f.new_path, 1_000) || str(f.old_path, 1_000),
				additions: null,
				deletions: null,
				patch: opt(f.diff),
			})),
		// The relay serves a merge request's notes as writes only; its thread is GitLab's own page.
		pullComments: async () => [],
		commentPull: async (n, body) => {
			await relay("POST", `${project}/merge_requests/${n}/notes`, { body });
		},
		merge: async (n) => {
			await relay("PUT", `${project}/merge_requests/${n}/merge`, {});
		},
		checks: async () => null,
	};
}

/** A saved review, read defensively: the runner's file of either forge. */
export function readReview(text: string | null | undefined): ForgeReview | null {
	if (!text) return null;
	let data: Json;
	try {
		data = obj(JSON.parse(text));
	} catch {
		return null;
	}
	const findings: ReviewFinding[] = list(data.findings).map((f, index) => ({
		id: opt(f.id) ?? String(index),
		severity: opt(f.severity) ?? "info",
		title: str(f.title, 500),
		description: str(f.description, 5_000),
		file: opt(f.file),
		line: num(f.line),
	}));
	return {
		summary: str(data.summary, 20_000),
		verdict: opt(data.verdict),
		findings: findings.filter((f) => f.title),
		reviewedAt: opt(data.reviewed_at),
	};
}
