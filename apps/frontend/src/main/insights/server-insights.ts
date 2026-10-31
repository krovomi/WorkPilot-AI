/**
 * Insights on a server project (server mode). The conversations are the
 * server's (`apps/backend/shared_features/insights.py`): each person writes
 * their own, every member reads all of them. A question is answered by a job
 * on the server; its output is followed here (`relayServerJob`) and read like
 * the local runner's (`output-lines.ts`), and the answer the server saved is
 * read back when it ends.
 *
 * Which conversation is open is this app's own choice, kept in memory per
 * project; nothing the server sends names a path.
 */

import { MODEL_ID_MAP } from "../../shared/constants";
import type {
	InsightsChatMessage,
	InsightsChatStatus,
	InsightsModelConfig,
	InsightsSession,
	InsightsSessionSummary,
	InsightsStreamChunk,
	IPCResult,
	Project,
} from "../../shared/types";
import { authedFetch } from "../server-connection";
import { relayServerJob } from "../server-features";
import { chunkForLine } from "./output-lines";

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_MESSAGE = 20_000;
const MAX_TITLE = 200;

/** The open conversation of each server project, by project id. */
const current = new Map<string, string>();

export interface InsightsEvents {
	chunk(chunk: InsightsStreamChunk): void;
	status(status: InsightsChatStatus): void;
	error(error: string): void;
	sessionUpdated(session: InsightsSession): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function date(value: unknown): Date {
	const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
	return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function modelConfig(value: unknown): InsightsModelConfig | undefined {
	if (!isRecord(value) || typeof value.model !== "string") return undefined;
	return {
		profileId: text(value.profileId, 40) || "balanced",
		model: value.model as InsightsModelConfig["model"],
		thinkingLevel: (text(value.thinkingLevel, 20) ||
			"medium") as InsightsModelConfig["thinkingLevel"],
	};
}

function message(value: unknown): InsightsChatMessage | null {
	if (!isRecord(value)) return null;
	const role = value.role;
	if (role !== "user" && role !== "assistant") return null;
	const suggested = isRecord(value.suggestedTask) ? value.suggestedTask : null;
	const tools = Array.isArray(value.toolsUsed) ? value.toolsUsed.filter(isRecord) : [];
	return {
		id: text(value.id, 64) || `msg-${Math.random().toString(36).slice(2)}`,
		role,
		content: text(value.content, 200_000),
		timestamp: date(value.timestamp),
		...(suggested && typeof suggested.title === "string"
			? {
					suggestedTask: {
						title: text(suggested.title, MAX_TITLE),
						description: text(suggested.description, 20_000),
						...(isRecord(suggested.metadata)
							? { metadata: suggested.metadata }
							: {}),
					},
				}
			: {}),
		...(tools.length > 0
			? {
					toolsUsed: tools.map((tool) => ({
						name: text(tool.name, 100),
						input: text(tool.input, 500) || undefined,
						timestamp: date(tool.timestamp),
					})),
				}
			: {}),
	};
}

function summary(project: Project, value: unknown): InsightsSessionSummary | null {
	if (!isRecord(value) || typeof value.id !== "string" || !SESSION_ID.test(value.id)) {
		return null;
	}
	return {
		id: value.id,
		projectId: project.id,
		title: text(value.title, MAX_TITLE) || "New Conversation",
		messageCount: typeof value.messageCount === "number" ? value.messageCount : 0,
		modelConfig: modelConfig(value.modelConfig),
		createdAt: date(value.createdAt),
		updatedAt: date(value.updatedAt),
		ownerName: text(value.ownerName, MAX_TITLE) || undefined,
		readOnly: value.mine !== true,
	};
}

function session(project: Project, value: unknown): InsightsSession | null {
	const head = summary(project, value);
	if (!head || !isRecord(value)) return null;
	const messages = Array.isArray(value.messages)
		? value.messages.map(message).filter((m): m is InsightsChatMessage => !!m)
		: [];
	return {
		id: head.id,
		projectId: project.id,
		title: head.title,
		messages,
		modelConfig: head.modelConfig,
		createdAt: head.createdAt,
		updatedAt: head.updatedAt,
		ownerName: head.ownerName,
		readOnly: head.readOnly,
	};
}

function sessionsUrl(project: Project, rest = ""): string {
	return `/api/features/insights/sessions${rest}?project_id=${encodeURIComponent(project.id)}`;
}

function sessionUrl(project: Project, sessionId: string, rest = ""): string {
	return sessionsUrl(project, `/${encodeURIComponent(sessionId)}${rest}`);
}

function validId(sessionId: unknown): sessionId is string {
	return typeof sessionId === "string" && SESSION_ID.test(sessionId);
}

/** Every conversation of the project, the newest first. */
export async function listServerSessions(
	project: Project,
): Promise<IPCResult<InsightsSessionSummary[]>> {
	const result = await authedFetch<unknown>(sessionsUrl(project), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const rows = Array.isArray(result.data) ? result.data : [];
	return {
		success: true,
		data: rows
			.map((row) => summary(project, row))
			.filter((row): row is InsightsSessionSummary => !!row),
	};
}

async function readSession(
	project: Project,
	sessionId: string,
): Promise<IPCResult<InsightsSession>> {
	const result = await authedFetch<unknown>(sessionUrl(project, sessionId), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const read = session(project, result.data);
	return read
		? { success: true, data: read }
		: { success: false, error: "Unexpected answer from the server" };
}

/**
 * The open conversation: the one chosen here, else the person's latest;
 * null when they have none yet.
 */
export async function getServerSession(
	project: Project,
): Promise<IPCResult<InsightsSession | null>> {
	const chosen = current.get(project.id);
	if (chosen) {
		const read = await readSession(project, chosen);
		if (read.success) return read;
		current.delete(project.id);
	}
	const listed = await listServerSessions(project);
	if (!listed.success) return { success: false, error: listed.error };
	const latest = listed.data?.find((row) => !row.readOnly);
	if (!latest) return { success: true, data: null };
	current.set(project.id, latest.id);
	return readSession(project, latest.id);
}

export async function newServerSession(
	project: Project,
	config?: InsightsModelConfig,
): Promise<IPCResult<InsightsSession>> {
	const result = await authedFetch<unknown>(
		sessionsUrl(project),
		"POST",
		config ? { modelConfig: config } : {},
	);
	if (!result.ok) return { success: false, error: result.error };
	const created = session(project, result.data);
	if (!created) return { success: false, error: "Unexpected answer from the server" };
	current.set(project.id, created.id);
	return { success: true, data: created };
}

export async function switchServerSession(
	project: Project,
	sessionId: unknown,
): Promise<IPCResult<InsightsSession | null>> {
	if (!validId(sessionId)) return { success: false, error: "Conversation not found" };
	const read = await readSession(project, sessionId);
	if (read.success) current.set(project.id, sessionId);
	return read;
}

export async function deleteServerSession(
	project: Project,
	sessionId: unknown,
): Promise<IPCResult> {
	if (!validId(sessionId)) return { success: false, error: "Conversation not found" };
	const result = await authedFetch(sessionUrl(project, sessionId), "DELETE");
	if (!result.ok) return { success: false, error: result.error };
	if (current.get(project.id) === sessionId) current.delete(project.id);
	return { success: true };
}

async function patch(
	project: Project,
	sessionId: unknown,
	body: Record<string, unknown>,
): Promise<IPCResult> {
	if (!validId(sessionId)) return { success: false, error: "Conversation not found" };
	const result = await authedFetch(sessionUrl(project, sessionId), "PATCH", body);
	return result.ok ? { success: true } : { success: false, error: result.error };
}

export function renameServerSession(
	project: Project,
	sessionId: unknown,
	title: unknown,
): Promise<IPCResult> {
	const name = typeof title === "string" ? title.trim() : "";
	if (!name || name.length > MAX_TITLE) {
		return Promise.resolve({ success: false, error: "Invalid title" });
	}
	return patch(project, sessionId, { title: name });
}

export function updateServerModelConfig(
	project: Project,
	sessionId: unknown,
	config: InsightsModelConfig,
): Promise<IPCResult> {
	return patch(project, sessionId, { modelConfig: config });
}

/** Empty the open conversation. */
export async function clearServerSession(project: Project): Promise<IPCResult> {
	const chosen = current.get(project.id);
	return chosen ? patch(project, chosen, { clear: true }) : { success: true };
}

/**
 * Ask in the open conversation (one is started when there is none), and
 * follow the answer: streamed as the local runner's, then read back as the
 * server saved it.
 */
export async function askServer(
	project: Project,
	question: string,
	config: InsightsModelConfig | undefined,
	events: InsightsEvents,
): Promise<void> {
	if (typeof question !== "string" || !question.trim() || question.length > MAX_MESSAGE) {
		events.error("Invalid message");
		return;
	}
	let open = await getServerSession(project);
	if (open.success && !open.data) open = await newServerSession(project, config);
	if (!open.success || !open.data) {
		events.error(open.error ?? "Server unavailable");
		return;
	}
	const conversation = open.data;
	if (conversation.readOnly) {
		events.error("This conversation is a teammate's: start your own to ask");
		return;
	}
	const model = config ? MODEL_ID_MAP[config.model] || config.model : undefined;
	const asked = await authedFetch<{ job?: { id?: unknown }; session?: unknown }>(
		sessionUrl(project, conversation.id, "/messages"),
		"POST",
		{
			message: question,
			...(model ? { model } : {}),
			...(config?.thinkingLevel ? { thinking_level: config.thinkingLevel } : {}),
		},
	);
	const jobId = asked.ok ? asked.data?.job?.id : undefined;
	if (!asked.ok || typeof jobId !== "string") {
		events.error(asked.ok ? "Unexpected answer from the server" : asked.error);
		return;
	}
	const withQuestion = session(project, asked.data?.session);
	if (withQuestion) events.sessionUpdated(withQuestion);
	events.status({ phase: "thinking", message: "Processing your message..." });

	const job = relayServerJob(project, "insights", { jobId });
	let pending = "";
	job.stdout.on("data", (data: Buffer) => {
		const lines = (pending + data.toString("utf-8")).split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const chunk = chunkForLine(line);
			if (chunk) events.chunk(chunk);
		}
	});
	let failure = "";
	job.stderr.on("data", (data: Buffer) => {
		failure = (failure + data.toString("utf-8")).slice(-2_000);
	});
	await new Promise<void>((resolve) => {
		job.on("exit", (code: number | null) => {
			void (async () => {
				if (code === 0) {
					events.chunk({ type: "done" });
					events.status({ phase: "complete" });
					const answered = await readSession(project, conversation.id);
					if (answered.success && answered.data) events.sessionUpdated(answered.data);
				} else if (code === null) {
					events.status({ phase: "idle" });
				} else {
					const error = failure.trim() || "The server could not answer";
					events.chunk({ type: "error", error });
					events.error(error);
				}
				resolve();
			})();
		});
	});
}
