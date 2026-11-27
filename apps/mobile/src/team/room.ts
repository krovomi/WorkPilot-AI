/**
 * The team room of a project, as the server's stream sends it
 * (`apps/backend/streaming/project_room.py`): who is here (`presence`), the
 * latest messages on arrival (`chat_history`), each new one (`chat_message`)
 * and why one of ours was not taken (`chat_rejected`). Everything is checked
 * and bounded here before a screen shows it; people come by id and name,
 * never by email.
 */

import type { StreamEvent } from "../board/stream";

/** The longest message the server takes (`server/services/team_chat.py`). */
export const CHAT_MAX = 2_000;
const MAX_HISTORY = 200;
const MAX_MEMBERS = 200;
const MAX_ID = 64;
const MAX_NAME = 200;

export const REJECTIONS = ["forbidden", "invalid", "too_fast", "unavailable"] as const;
export type ChatRejection = (typeof REJECTIONS)[number];

export interface ChatMessage {
	id: string;
	authorId: string;
	author: string;
	message: string;
	/** The message it answers, when it answers one of this project. */
	replyTo: string | null;
	at: string;
}

export interface Member {
	id: string;
	name: string;
}

export type RoomEvent =
	| { kind: "presence"; members: Member[] }
	| { kind: "history"; messages: ChatMessage[] }
	| { kind: "message"; message: ChatMessage }
	| { kind: "rejected"; reason: ChatRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** A stored message, or null for anything that is not one. */
export function readMessage(raw: unknown): ChatMessage | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id, MAX_ID);
	const message = text(raw.message, CHAT_MAX);
	const at = text(raw.at, MAX_ID);
	if (!id || !message || !at) return null;
	return {
		id,
		authorId: text(raw.author_id, MAX_ID) ?? "",
		author: text(raw.author, MAX_NAME) ?? "?",
		message,
		replyTo: text(raw.reply_to, MAX_ID),
		at,
	};
}

function readMember(raw: unknown): Member | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id, MAX_ID);
	return id ? { id, name: text(raw.name, MAX_NAME) ?? "?" } : null;
}

/** A stream event of the room; null for the board's events and anything malformed. */
export function readRoomEvent(event: StreamEvent): RoomEvent | null {
	const list = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(-max) : []);
	switch (event.type) {
		case "presence":
			return {
				kind: "presence",
				members: list(event.data.users, MAX_MEMBERS)
					.map(readMember)
					.filter((m): m is Member => m !== null),
			};
		case "chat_history":
			return {
				kind: "history",
				messages: list(event.data.messages, MAX_HISTORY)
					.map(readMessage)
					.filter((m): m is ChatMessage => m !== null),
			};
		case "chat_message": {
			const message = readMessage(event.data);
			return message ? { kind: "message", message } : null;
		}
		case "chat_rejected": {
			const reason = REJECTIONS.find((r) => r === event.data.reason);
			return reason ? { kind: "rejected", reason } : null;
		}
		default:
			return null;
	}
}

/** The conversation with a new message at its end, once, and at most the last 200. */
export function withMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
	if (messages.some((m) => m.id === message.id)) return [...messages];
	return [...messages, message].slice(-MAX_HISTORY);
}
