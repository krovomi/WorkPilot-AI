/**
 * The steering queue's file, as the backend reads it (`foundation/steering.py`):
 * `steering.jsonl` in every copy of the spec directory, one event per line,
 * appended to and never rewritten (the backend marks deliveries in the same
 * file while the app adds messages).
 */

import type { SteeringMessage } from "../types/steering";

export const STEERING_FILE = "steering.jsonl";
export const MAX_STEERING_CHARS = 4000;
/** The element of the preview a message points at (F10): `MAX_CONTEXT_CHARS` in `foundation/steering.py`. */
export const MAX_CONTEXT_CHARS = 8000;
/** A subtask id as planners write them (`subtask-1-2`, `change-request-…`). */
export const SUBTASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Control and invisible characters out (newlines and tabs kept), bounded. */
export function cleanSteeringText(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
		.trim()
		.slice(0, MAX_STEERING_CHARS);
}

/** The line that queues a message. */
export function messageLine(
	id: string,
	text: string,
	createdAt: string,
	source: string,
	targetSubtaskId: string | null,
	context = "",
): string {
	return `${JSON.stringify({
		type: "message",
		id,
		text,
		created_at: createdAt,
		source,
		target_subtask_id: targetSubtaskId,
		...(context ? { context: context.slice(0, MAX_CONTEXT_CHARS) } : {}),
	})}\n`;
}

type Event = Record<string, unknown>;

function events(content: string): Event[] {
	const out: Event[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as unknown;
			if (event && typeof event === "object" && typeof (event as Event).id === "string") {
				out.push(event as Event);
			}
		} catch {
			// A line cut by a crash: the others still count.
		}
	}
	return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Every message across the copies' contents, oldest first, with its delivery. */
export function parseSteering(contents: readonly string[]): SteeringMessage[] {
	const messages = new Map<string, Event>();
	const deliveries = new Map<string, Event>();
	for (const content of contents) {
		for (const event of events(content)) {
			const id = event.id as string;
			if (event.type === "message" && typeof event.text === "string") {
				if (!messages.has(id)) messages.set(id, event);
			} else if (event.type === "delivered" && !deliveries.has(id)) {
				deliveries.set(id, event);
			}
		}
	}
	return [...messages.entries()]
		.map(([id, m]) => {
			const d = deliveries.get(id);
			return {
				id,
				text: cleanSteeringText(m.text as string),
				createdAt: str(m.created_at) ?? "",
				source: str(m.source) ?? "",
				targetSubtaskId: str(m.target_subtask_id),
				deliveredAt: d ? str(d.at) : null,
				deliveredSession: d && typeof d.session === "number" ? d.session : null,
				deliveredSubtaskId: d ? str(d.subtask_id) : null,
				...(typeof m.context === "string" && m.context ? { hasContext: true } : {}),
			};
		})
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
