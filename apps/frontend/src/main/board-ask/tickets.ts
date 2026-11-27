/**
 * The tickets of a board as « Interroger le tableau » reads them
 * (docs/architecture/board-ask.md): every card of the project, finished,
 * archived and abandoned ones included, since a product owner asks what was
 * already built.
 */

import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { BoardAskState, ReviewReason, Task } from "../../shared/types";
import type { SearchDocument } from "../../shared/utils/board-ask-search";

/** What is read of a spec file, at most: its opening says what the task is. */
const SPEC_BYTES = 16 * 1024;
const SPEC_CHARS = 1500;
const DESCRIPTION_CHARS = 2000;
const MAX_SUBTASKS = 12;
const MAX_FILES = 20;

const FAILED_REVIEWS: ReadonlySet<ReviewReason> = new Set(["errors", "prompt_too_long", "qa_rejected"]);

export interface BoardTicket {
	id: string;
	title: string;
	description: string;
	/** The opening of the spec the agents wrote, when there is one. */
	spec: string;
	subtasks: string[];
	files: string[];
	state: BoardAskState;
	updatedAt?: string;
	archived: boolean;
	/** The ticket it was imported from (Jira, Azure DevOps), when it was. */
	external?: string;
}

/** Where a task stands, said the way a product owner reads it. */
export function ticketState(task: Pick<Task, "status" | "reviewReason" | "metadata">): BoardAskState {
	if (task.metadata?.abandoned === true) return "abandoned";
	switch (task.status) {
		case "done":
			return "done";
		case "pr_created":
			return "in_review";
		case "human_review":
			return task.reviewReason && FAILED_REVIEWS.has(task.reviewReason) ? "failed" : "in_review";
		case "ai_review":
			return "in_review";
		case "in_progress":
			return "in_progress";
		case "error":
		case "build_failed":
			return "failed";
		default:
			return "planned";
	}
}

/** The opening of `<spec>/spec.md`, or "" (no spec yet, unreadable). */
export function readSpecOpening(specsPath: string | undefined): string {
	if (!specsPath) return "";
	let fd: number | undefined;
	try {
		fd = openSync(path.join(specsPath, "spec.md"), "r");
		const buffer = Buffer.alloc(SPEC_BYTES);
		const read = readSync(fd, buffer, 0, SPEC_BYTES, 0);
		return buffer
			.subarray(0, read)
			.toString("utf-8")
			.replace(/^#+\s*/gm, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, SPEC_CHARS);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function isoDate(value: unknown): string | undefined {
	const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

export function toTicket(task: Task, readSpec: (task: Task) => string = (t) => readSpecOpening(t.specsPath)): BoardTicket {
	const subtasks = (task.subtasks ?? [])
		.slice(0, MAX_SUBTASKS)
		.map((s) => `${s.title ?? ""} ${s.description ?? ""}`.trim())
		.filter(Boolean);
	const files = [...new Set((task.subtasks ?? []).flatMap((s) => s.files ?? []))].slice(0, MAX_FILES);
	const metadata = task.metadata;
	return {
		id: task.id,
		title: String(task.title ?? "").trim(),
		description: String(task.description ?? "").slice(0, DESCRIPTION_CHARS),
		spec: readSpec(task),
		subtasks,
		files,
		state: ticketState(task),
		updatedAt: isoDate(task.updatedAt) ?? isoDate(task.createdAt),
		archived: Boolean(metadata?.archivedAt),
		external: metadata?.jiraIdentifier ?? metadata?.azureDevOpsIdentifier,
	};
}

/** The fields the keyword search reads, the title counting most. */
export function ticketDocument(ticket: BoardTicket): SearchDocument {
	return {
		id: ticket.id,
		fields: [
			{ text: ticket.title, weight: 3 },
			{ text: ticket.description, weight: 1 },
			{ text: ticket.spec, weight: 1 },
			{ text: ticket.subtasks.join("\n"), weight: 0.7 },
			// "src/admin/AdminPage.tsx" says "admin page" too.
			{ text: ticket.files.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2"), weight: 0.5 },
		],
	};
}

/** A ticket in a few lines for the model: what it is, where it stands. */
export function ticketDigest(ticket: BoardTicket, maxChars: number): string {
	const lines = [
		`Title: ${ticket.title}`,
		`State: ${ticket.state}${ticket.archived ? " (archived)" : ""}${ticket.updatedAt ? `, last change ${ticket.updatedAt.slice(0, 10)}` : ""}`,
	];
	if (ticket.description) lines.push(`Description: ${ticket.description.replace(/\s+/g, " ").slice(0, 500)}`);
	if (ticket.spec) lines.push(`Spec: ${ticket.spec.slice(0, 400)}`);
	if (ticket.subtasks.length > 0) lines.push(`Steps: ${ticket.subtasks.map((s) => s.slice(0, 80)).join(" | ")}`);
	if (ticket.files.length > 0) lines.push(`Files: ${ticket.files.slice(0, 8).join(", ")}`);
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
