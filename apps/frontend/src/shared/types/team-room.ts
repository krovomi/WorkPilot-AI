/**
 * The team room of a server project (server mode): who is on the project,
 * whose claim holds which card, the team chat and what teammates did.
 * The main process follows it on the project's stream (`main/server-team-room.ts`).
 */

import type { IPCResult } from "./common";
import type { Task } from "./task";

export interface TeamMember {
	id: string;
	name: string;
}

/** A card a person claimed: only they (or an owner releasing it) may act on it. */
export interface TeamLock {
	/** The app's task id of the card (`server:<project>:<card>`). */
	taskId: string;
	cardId: string;
	userId: string;
	userName: string;
}

export interface TeamChatMessage {
	id: string;
	authorId: string;
	author: string;
	message: string;
	/** The id of the message this one answers, or "". */
	replyTo: string;
	/** ISO 8601. */
	at: string;
}

/** Why the server did not take a message. */
export type TeamChatRejection = "forbidden" | "invalid" | "too_fast" | "unavailable";

/** Something a teammate did, worth a notification. */
export type TeamActivity =
	| { type: "joined" | "left"; user: string }
	| { type: "claimed" | "released"; user: string; card: string }
	| {
			type: "run_finished";
			user: string;
			card: string;
			phase: string;
			status: "succeeded" | "failed" | "cancelled";
	  };

export type TeamRoomUpdate =
	| {
			kind: "state";
			projectId: string;
			/** The stream is open. */
			live: boolean;
			me: TeamMember | null;
			users: TeamMember[];
			locks: TeamLock[];
	  }
	| { kind: "chat"; projectId: string; messages: TeamChatMessage[]; replace: boolean }
	| { kind: "rejected"; projectId: string; reason: TeamChatRejection }
	| { kind: "activity"; projectId: string; activity: TeamActivity };

/** The longest chat message, as the server takes it (`server/services/team_chat.py`). */
export const TEAM_CHAT_MAX = 2000;

/**
 * A field of a server card a teammate changed while this person was editing
 * it: the edit is not saved until the person picks which version to keep.
 */
export interface CardEditConflict {
	field: "title" | "description";
	mine: string;
	theirs: string;
}

/** `TASK_UPDATE`'s error when the edit met a teammate's change. */
export const CARD_EDIT_CONFLICT = "cardEditConflict";

/** What `TASK_UPDATE` answers: on a conflict, the fields that met one. */
export interface TaskUpdateResult extends IPCResult<Task> {
	conflicts?: CardEditConflict[];
}
