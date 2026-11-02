/**
 * The team room of a server project (server mode): who is on the project now,
 * whose claim holds which card, the team chat, and what teammates did.
 *
 * While a server board is shown, the window joins its room. The room holds
 * the project's stream (`server-project-stream.ts`), where the server sends
 * `presence`, `chat_history`, `chat_message` and `chat_rejected`
 * (`apps/backend/streaming/project_room.py`) beside the board's events. The
 * claims are read from the server's spec index whenever a board event may
 * have changed one. What the server sends is checked and bounded here before
 * it reaches the window, which gets names and ids only, never an email.
 */

import type {
	IPCResult,
	TeamActivity,
	TeamChatMessage,
	TeamChatRejection,
	TeamLock,
	TeamMember,
	TeamRoomUpdate,
} from "../shared/types";
import { TEAM_CHAT_MAX } from "../shared/types/team-room";
import { parseServerTaskId, serverTaskId } from "./remote-board";
import { findServerCard, serverCardIndexId } from "./server-board-actions";
import { authedFetch, getAuthState } from "./server-connection";
import {
	holdProjectStream,
	sendOnProjectStream,
	type StreamEvent,
} from "./server-project-stream";
import { getServerProject } from "./server-projects";

const MAX_USERS = 200;
const MAX_LOCKS = 500;
const MAX_HISTORY = 200;
const MAX_ID = 64;
const MAX_NAME = 200;
const LOCKS_DEBOUNCE_MS = 300;
/** Board events after which a claim may have changed. */
const CLAIM_EVENTS = new Set([
	"spec_created",
	"spec_deleted",
	"spec_claimed",
	"spec_released",
	"spec_status_changed",
]);
const REJECTIONS = new Set<TeamChatRejection>(["forbidden", "invalid", "too_fast", "unavailable"]);
const RUN_ENDS = new Set(["succeeded", "failed", "cancelled"]);

type Notify = (update: TeamRoomUpdate) => void;

interface Room {
	projectId: string;
	notify: Notify;
	release: (() => void) | null;
	live: boolean;
	/** The roster was received since the stream opened: later ones are arrivals. */
	rosterKnown: boolean;
	users: TeamMember[];
	locks: TeamLock[];
	locksTimer: ReturnType<typeof setTimeout> | null;
	locksRead: number;
}

const rooms = new Map<string, Room>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length <= max ? value : null;
}

function me(): TeamMember | null {
	const user = getAuthState().user;
	return user ? { id: user.id, name: user.display_name } : null;
}

/** The roster the server sent, or null when it is not one. */
export function parseRoster(data: Readonly<Record<string, unknown>>): TeamMember[] | null {
	if (!Array.isArray(data.users)) return null;
	const users: TeamMember[] = [];
	for (const raw of data.users.slice(0, MAX_USERS)) {
		if (!isRecord(raw)) continue;
		const id = text(raw.id, MAX_ID);
		const name = text(raw.name, MAX_NAME);
		if (id && name !== null) users.push({ id, name });
	}
	return users;
}

/** A chat message the server sent, or null when it is not one. */
export function parseChatMessage(raw: unknown): TeamChatMessage | null {
	if (!isRecord(raw)) return null;
	const id = text(raw.id, MAX_ID);
	const authorId = text(raw.author_id, MAX_ID);
	const author = text(raw.author, MAX_NAME);
	const message = text(raw.message, TEAM_CHAT_MAX);
	const replyTo = text(raw.reply_to ?? "", MAX_ID);
	const at = text(raw.at, MAX_ID);
	if (!id || authorId === null || author === null || !message || replyTo === null || !at) {
		return null;
	}
	return { id, authorId, author, message, replyTo, at };
}

/** The claims of a server project's cards, read from its spec index. */
export function parseLocks(projectId: string, rows: unknown): TeamLock[] {
	if (!Array.isArray(rows)) return [];
	const locks: TeamLock[] = [];
	for (const row of rows) {
		if (locks.length >= MAX_LOCKS) break;
		if (!isRecord(row)) continue;
		const cardId = text(row.spec_name, MAX_ID * 2);
		const userId = text(row.claimed_by, MAX_ID);
		if (!cardId || !userId) continue;
		const taskId = serverTaskId(projectId, cardId);
		if (!parseServerTaskId(taskId)) continue;
		locks.push({ taskId, cardId, userId, userName: text(row.claimed_by_name, MAX_NAME) ?? "" });
	}
	return locks;
}

/** What a teammate did, read from a board event; null for one of mine or none. */
export function activityOf(event: StreamEvent, myId: string | null): TeamActivity | null {
	const user = text(event.data.user_name, MAX_NAME) ?? "";
	const card = text(event.data.spec_name, MAX_ID * 2);
	if (!card || (myId && event.data.user_id === myId)) return null;
	if (event.type === "spec_claimed") return { type: "claimed", user, card };
	if (event.type === "spec_released") return { type: "released", user, card };
	if (event.type === "spec_status_changed") {
		const status = event.data.run_status;
		const phase = text(event.data.phase, MAX_ID) ?? "";
		if (typeof status === "string" && RUN_ENDS.has(status)) {
			return {
				type: "run_finished",
				user,
				card,
				phase,
				status: status as "succeeded" | "failed" | "cancelled",
			};
		}
	}
	return null;
}

function sendState(room: Room): void {
	room.notify({
		kind: "state",
		projectId: room.projectId,
		live: room.live,
		me: me(),
		users: room.users,
		locks: room.locks,
	});
}

async function readLocks(room: Room): Promise<void> {
	const project = getServerProject(room.projectId);
	if (!project) return;
	const read = ++room.locksRead;
	const result = await authedFetch<unknown>(
		`/projects/${encodeURIComponent(room.projectId)}/specs`,
		"GET",
	);
	// A later read, or the room was left: this answer is stale.
	if (!result.ok || rooms.get(room.projectId) !== room || read !== room.locksRead) return;
	room.locks = parseLocks(room.projectId, result.data);
	sendState(room);
}

function readLocksSoon(room: Room): void {
	if (room.locksTimer) clearTimeout(room.locksTimer);
	room.locksTimer = setTimeout(() => {
		room.locksTimer = null;
		void readLocks(room);
	}, LOCKS_DEBOUNCE_MS);
}

function onRoster(room: Room, users: TeamMember[]): void {
	const myId = me()?.id ?? null;
	if (room.rosterKnown) {
		const before = new Map(room.users.map((u) => [u.id, u.name]));
		const after = new Map(users.map((u) => [u.id, u.name]));
		for (const [id, name] of after) {
			if (id !== myId && !before.has(id)) {
				room.notify({ kind: "activity", projectId: room.projectId, activity: { type: "joined", user: name } });
			}
		}
		for (const [id, name] of before) {
			if (id !== myId && !after.has(id)) {
				room.notify({ kind: "activity", projectId: room.projectId, activity: { type: "left", user: name } });
			}
		}
	}
	room.rosterKnown = true;
	room.users = users;
	sendState(room);
}

function onEvent(room: Room, event: StreamEvent): void {
	if (event.type === "presence") {
		const users = parseRoster(event.data);
		if (users) onRoster(room, users);
		return;
	}
	if (event.type === "chat_history" || event.type === "chat_message") {
		const raw =
			event.type === "chat_history"
				? Array.isArray(event.data.messages)
					? event.data.messages.slice(-MAX_HISTORY)
					: []
				: [event.data];
		const messages = raw
			.map(parseChatMessage)
			.filter((m): m is TeamChatMessage => m !== null);
		const replace = event.type === "chat_history";
		if (replace || messages.length > 0) {
			room.notify({ kind: "chat", projectId: room.projectId, messages, replace });
		}
		return;
	}
	if (event.type === "chat_rejected") {
		const reason = event.data.reason as TeamChatRejection;
		if (REJECTIONS.has(reason)) {
			room.notify({ kind: "rejected", projectId: room.projectId, reason });
		}
		return;
	}
	if (CLAIM_EVENTS.has(event.type)) {
		const activity = activityOf(event, me()?.id ?? null);
		if (activity) room.notify({ kind: "activity", projectId: room.projectId, activity });
		readLocksSoon(room);
	}
}

/** Join a server project's room; replaces an earlier join of it. */
export function joinTeamRoom(projectId: unknown, notify: Notify): boolean {
	if (typeof projectId !== "string" || !getServerProject(projectId)) return false;
	leaveTeamRoom(projectId);
	const room: Room = {
		projectId,
		notify,
		release: null,
		live: false,
		rosterKnown: false,
		users: [],
		locks: [],
		locksTimer: null,
		locksRead: 0,
	};
	rooms.set(projectId, room);
	room.release = holdProjectStream(projectId, {
		onLive: (live) => {
			if (rooms.get(projectId) !== room) return;
			room.live = live;
			// The server sends the roster on each connection; until then, nobody.
			room.rosterKnown = false;
			if (!live) room.users = [];
			sendState(room);
			if (live) void readLocks(room);
		},
		onEvent: (event) => {
			if (rooms.get(projectId) === room) onEvent(room, event);
		},
	});
	if (!room.release) {
		rooms.delete(projectId);
		return false;
	}
	sendState(room);
	return true;
}

export function leaveTeamRoom(projectId: unknown): void {
	if (typeof projectId !== "string") return;
	const room = rooms.get(projectId);
	if (!room) return;
	rooms.delete(projectId);
	if (room.locksTimer) clearTimeout(room.locksTimer);
	room.release?.();
}

/** Leave every room (sign-out, another server, the window closing). */
export function leaveAllTeamRooms(): void {
	for (const projectId of [...rooms.keys()]) leaveTeamRoom(projectId);
}

/** Send a message to the team chat of a room this window joined. */
export function sendTeamChat(projectId: unknown, message: unknown, replyTo: unknown): IPCResult {
	if (typeof projectId !== "string" || !rooms.has(projectId)) {
		return { success: false, error: "notJoined" };
	}
	const body = typeof message === "string" ? message.trim() : "";
	const reply = typeof replyTo === "string" && replyTo.length <= MAX_ID ? replyTo : "";
	if (!body || body.length > TEAM_CHAT_MAX) return { success: false, error: "invalid" };
	const sent = sendOnProjectStream(projectId, {
		type: "chat_message",
		message: body,
		...(reply ? { reply_to: reply } : {}),
	});
	return sent ? { success: true } : { success: false, error: "offline" };
}

/**
 * Release a card's claim. The server decides: the holder releases their own,
 * a project owner anyone's; anyone else is refused.
 */
export async function releaseCardClaim(taskId: unknown): Promise<IPCResult> {
	const card = findServerCard(taskId);
	if (!card) return { success: false, error: "notFound" };
	const id = await serverCardIndexId(card);
	if (!id.success || !id.data) return { success: false, error: id.error };
	const result = await authedFetch(
		`/projects/${encodeURIComponent(card.project.id)}/specs/${encodeURIComponent(id.data)}/release`,
		"POST",
	);
	if (!result.ok) return { success: false, error: result.error };
	const room = rooms.get(card.project.id);
	if (room) readLocksSoon(room);
	return { success: true };
}
