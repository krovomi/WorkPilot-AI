/**
 * The shared features of a server project (server mode): roadmap, ideation,
 * the project's index (the Context view).
 *
 * A feature's files live on the server's clone (`.workpilot/<feature>/`),
 * and its runner runs there (`apps/backend/shared_features/`). The app reads
 * them into the project's mirror, in a local project's layout, so the
 * feature's own handlers read them as they read a local project's. A change
 * is written to the mirror, then sent to the server with the SHA-256 of the
 * version it started from: when a teammate saved in between, the server
 * refuses, the mirror is read again and the person sees the newer version.
 *
 * A job (generate, refresh) is the server's: `startServerJob` returns an
 * object shaped like the child process the feature's handlers already follow,
 * fed by the job's output, so progress, completion and stop work unchanged.
 *
 * What the server sends is checked again here: only the feature's declared
 * files, each under its size. The app never sends a path.
 */

import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { IDEATION_TYPE_LABELS } from "../shared/constants/ideation";
import type { IPCResult, Project } from "../shared/types";
import { authedFetch } from "./server-connection";

export type SharedFeature = "roadmap" | "ideation" | "context";
/** What runs jobs on the server: a feature with files, or Insights. */
export type JobFeature = SharedFeature | "insights";

interface FeatureFiles {
	directory: string;
	files: ReadonlyMap<string, number>;
}

/** As declared by the server (`shared_features/registry.py`). */
export const SHARED_FEATURES: Readonly<Record<SharedFeature, FeatureFiles>> = {
	roadmap: {
		directory: path.join(".workpilot", "roadmap"),
		files: new Map([
			["roadmap.json", 2_000_000],
			["competitor_analysis.json", 1_000_000],
			["roadmap_discovery.json", 500_000],
		]),
	},
	ideation: {
		directory: path.join(".workpilot", "ideation"),
		files: new Map([
			["ideation.json", 2_000_000],
			// Written type by type while a job runs.
			...Object.keys(IDEATION_TYPE_LABELS).map(
				(kind): [string, number] => [`${kind}_ideas.json`, 1_000_000],
			),
		]),
	},
	context: {
		directory: ".workpilot",
		// Rebuilt by the analyzer, never written by the app.
		files: new Map([["project_index.json", 4_000_000]]),
	},
};

const SHA256 = /^[0-9a-f]{64}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ACTIVE = new Set(["queued", "running"]);
const FINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_LINES_PER_READ = 400;
const MAX_LINE = 2_000;

export interface ServerJob {
	id: string;
	status: string;
	error: string | null;
}

/** The version of each mirrored file the app read: `<project>:<feature>:<file>`. */
const versions = new Map<string, string>();

function versionKey(project: Project, feature: SharedFeature, name: string) {
	return `${project.id}:${feature}:${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every shared file is a JSON object: anything else is not mirrored. */
function isJsonObject(text: string): boolean {
	try {
		return isRecord(JSON.parse(text));
	} catch {
		return false;
	}
}

function base(project: Project, feature: JobFeature, rest = ""): string {
	return `/api/features/${feature}${rest}${rest.includes("?") ? "&" : "?"}project_id=${encodeURIComponent(project.id)}`;
}

export function parseJob(raw: unknown): ServerJob | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || !JOB_ID.test(raw.id)) {
		return null;
	}
	const status = typeof raw.status === "string" ? raw.status : "";
	if (!ACTIVE.has(status) && !FINAL.has(status)) return null;
	return {
		id: raw.id,
		status,
		error: typeof raw.error === "string" ? raw.error.slice(0, 4_000) : null,
	};
}

/** The mirrored file of a feature. */
export function featureFile(
	project: Project,
	feature: SharedFeature,
	name: string,
): string {
	return path.join(project.path, SHARED_FEATURES[feature].directory, name);
}

/**
 * Read a feature's files from the server into the mirror: each declared
 * file as the server has it, none that it does not have. Returns the
 * feature's latest job, so a view can follow one a teammate started.
 */
export async function pullFeature(
	project: Project,
	feature: SharedFeature,
): Promise<IPCResult<{ job: ServerJob | null }>> {
	const result = await authedFetch<unknown>(base(project, feature, "/snapshot"), "GET");
	if (!result.ok) return { success: false, error: result.error };
	if (!isRecord(result.data) || !isRecord(result.data.files)) {
		return { success: false, error: "Unexpected answer from the server" };
	}
	const served = result.data.files;
	const { directory, files } = SHARED_FEATURES[feature];
	mkdirSync(path.join(project.path, directory), { recursive: true });
	for (const [name, limit] of files) {
		const target = featureFile(project, feature, name);
		const entry = served[name];
		const content = isRecord(entry) ? entry.content : undefined;
		const sha = isRecord(entry) ? entry.sha256 : undefined;
		if (
			typeof content === "string" &&
			Buffer.byteLength(content, "utf-8") <= limit &&
			isJsonObject(content) &&
			typeof sha === "string" &&
			SHA256.test(sha)
		) {
			writeFileSync(target, content, "utf-8");
			versions.set(versionKey(project, feature, name), sha);
		} else {
			rmSync(target, { force: true });
			versions.delete(versionKey(project, feature, name));
		}
	}
	return { success: true, data: { job: parseJob(result.data.job) } };
}

/**
 * Send a mirrored file the person changed. Refused when a teammate saved it
 * since it was read: the mirror is then read again, so the next look shows
 * their version.
 */
export async function pushFeatureFile(
	project: Project,
	feature: SharedFeature,
	name: string,
): Promise<IPCResult> {
	if (!SHARED_FEATURES[feature].files.has(name)) {
		return { success: false, error: "Unknown file" };
	}
	const target = featureFile(project, feature, name);
	if (!existsSync(target)) return { success: false, error: "File not found" };
	const content = readFileSync(target, "utf-8");
	const key = versionKey(project, feature, name);
	const result = await authedFetch<{ sha256?: unknown }>(
		base(project, feature, `/files/${encodeURIComponent(name)}`),
		"PUT",
		{ content, base_sha256: versions.get(key) ?? null },
	);
	if (!result.ok) {
		await pullFeature(project, feature);
		return { success: false, error: result.error };
	}
	const sha = result.data?.sha256;
	if (typeof sha === "string" && SHA256.test(sha)) versions.set(key, sha);
	return { success: true };
}

/** What a job relay emits: the events of a child process the handlers follow. */
interface JobStream extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	pid: undefined;
	killed: boolean;
	kill(): boolean;
}

export interface JobRelayOptions {
	/** How often the job is read while it runs. */
	pollMs?: number;
	/** Failed reads in a row before the relay gives up. */
	maxFailures?: number;
}

/**
 * A server job, followed like a child process: its output arrives on
 * `stdout`, its end as `exit` (0 when it succeeded, after the feature's files
 * were read into the mirror; Insights has none), and `kill()` asks the server
 * to stop it.
 * Either starts a job (`options`) or follows one already running (`jobId`).
 */
export function relayServerJob(
	project: Project,
	feature: JobFeature,
	start: { options: Record<string, unknown> } | { jobId: string },
	relay: JobRelayOptions = {},
): JobStream {
	const pollMs = relay.pollMs ?? 1_500;
	const maxFailures = relay.maxFailures ?? 20;
	const stream = new EventEmitter() as JobStream;
	stream.stdout = new EventEmitter();
	stream.stderr = new EventEmitter();
	stream.pid = undefined;
	stream.killed = false;
	let jobId: string | null = "jobId" in start ? start.jobId : null;
	let next = 0;
	let failures = 0;
	let cancelSent = false;
	let done = false;

	const finish = (code: number | null, error?: string) => {
		if (done) return;
		done = true;
		if (error) stream.stderr.emit("data", Buffer.from(`${error}\n`, "utf-8"));
		stream.emit("exit", code);
	};

	const guarded = (step: () => Promise<void>) => () => {
		step().catch((error: unknown) =>
			finish(1, error instanceof Error ? error.message : String(error)),
		);
	};

	const cancel = async () => {
		if (!jobId || cancelSent) return;
		cancelSent = true;
		await authedFetch(
			base(project, feature, `/jobs/${encodeURIComponent(jobId)}/cancel`),
			"POST",
		);
	};

	const poll = async (): Promise<void> => {
		if (done || !jobId) return;
		const result = await authedFetch<unknown>(
			base(project, feature, `/jobs/${encodeURIComponent(jobId)}?after=${next}`),
			"GET",
		);
		if (!result.ok || !isRecord(result.data)) {
			failures += 1;
			if (failures >= maxFailures) {
				finish(1, `Lost the server job: ${result.ok ? "bad answer" : result.error}`);
				return;
			}
			setTimeout(guarded(poll), pollMs);
			return;
		}
		failures = 0;
		const data = result.data;
		const lines = Array.isArray(data.lines)
			? data.lines
					.filter((line): line is string => typeof line === "string")
					.slice(-MAX_LINES_PER_READ)
					.map((line) => line.slice(0, MAX_LINE))
			: [];
		if (typeof data.next === "number" && data.next >= next) next = data.next;
		if (lines.length > 0) {
			stream.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf-8"));
		}
		const job = parseJob(data);
		if (job && FINAL.has(job.status)) {
			if (job.status === "succeeded") {
				const pulled =
					feature === "insights"
						? { success: true as const, error: undefined }
						: await pullFeature(project, feature);
				finish(
					pulled.success ? 0 : 1,
					pulled.success ? undefined : pulled.error,
				);
			} else if (job.status === "cancelled") {
				finish(null);
			} else {
				finish(1, job.error ?? "The server job failed");
			}
			return;
		}
		setTimeout(guarded(poll), pollMs);
	};

	stream.kill = () => {
		stream.killed = true;
		void cancel();
		return true;
	};

	const begin = async () => {
		if (jobId) {
			await poll();
			return;
		}
		const options = "options" in start ? start.options : {};
		const result = await authedFetch<unknown>(
			base(project, feature, "/jobs"),
			"POST",
			options,
		);
		const job = result.ok ? parseJob(result.data) : null;
		if (!job) {
			finish(1, result.ok ? "Unexpected answer from the server" : result.error);
			return;
		}
		jobId = job.id;
		if (stream.killed) await cancel();
		await poll();
	};
	// The caller attaches its listeners first, as with a spawned process.
	setTimeout(guarded(begin), 0);
	return stream;
}

/** Whether a server job is still queued or running. */
export function isActiveJob(job: ServerJob | null): job is ServerJob {
	return !!job && ACTIVE.has(job.status);
}
