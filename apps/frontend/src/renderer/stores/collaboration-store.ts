/**
 * The team room of the shown server board (server mode): who is on the
 * project, whose claim holds which card, the team chat, and what teammates
 * did. The main process follows the room on the project's stream
 * (`main/server-team-room.ts`) and sends its updates here; this store only
 * keeps them for the components of `components/collaboration/`.
 *
 * The person's collaboration settings (what to show, what to be told, how to
 * settle an edit conflict) live in this browser profile's local storage.
 */

import { create } from "zustand";
import type {
	TeamActivity,
	TeamChatMessage,
	TeamChatRejection,
	TeamLock,
	TeamMember,
	TeamRoomUpdate,
} from "../../shared/types";

/**
 * What to do when a card edit meets a teammate's change of the same field:
 * ask (`manual`), keep this person's edit (`last_write_wins`) or keep the
 * teammate's (`first_write_wins`).
 */
export type ConflictStrategy = "manual" | "last_write_wins" | "first_write_wins";

export interface CollaborationSettings {
	conflictStrategy: ConflictStrategy;
	showPresenceIndicator: boolean;
	chatEnabled: boolean;
	notifyUserJoinLeave: boolean;
	notifyTaskLocks: boolean;
	notifyAgentActivity: boolean;
	notifyChatMentions: boolean;
}

export const DEFAULT_COLLABORATION_SETTINGS: CollaborationSettings = {
	conflictStrategy: "manual",
	showPresenceIndicator: true,
	chatEnabled: true,
	notifyUserJoinLeave: true,
	notifyTaskLocks: true,
	notifyAgentActivity: true,
	notifyChatMentions: true,
};

const SETTINGS_KEY = "workpilot.collaboration.settings";
const MAX_MESSAGES = 200;
const MAX_ACTIVITIES = 50;

/** A notification to show once: a teammate's action, or a mention of me. */
export type CollaborationNotice =
	| { seq: number; kind: "activity"; activity: TeamActivity }
	| { seq: number; kind: "mention"; author: string; message: string }
	| { seq: number; kind: "rejected"; reason: TeamChatRejection };

type NoticeBody = CollaborationNotice extends infer N
	? N extends CollaborationNotice
		? Omit<N, "seq">
		: never
	: never;

const AVATAR_COLORS = [
	"#ef4444",
	"#f97316",
	"#eab308",
	"#22c55e",
	"#14b8a6",
	"#3b82f6",
	"#6366f1",
	"#a855f7",
	"#ec4899",
	"#f43f5e",
];

/** A stable color for a person. */
export function avatarColor(userId: string): string {
	let hash = 0;
	for (let i = 0; i < userId.length; i++) {
		hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
	}
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** Whether a message names `me` as `@Name` (case and spaces as written). */
export function mentions(message: string, me: TeamMember | null): boolean {
	const name = me?.name.trim();
	if (!name) return false;
	const at = message.toLowerCase().indexOf(`@${name.toLowerCase()}`);
	if (at < 0) return false;
	const after = message.charAt(at + name.length + 1);
	return after === "" || !/[\p{L}\p{N}_]/u.test(after);
}

function loadSettings(): CollaborationSettings {
	try {
		const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_COLLABORATION_SETTINGS };
		const saved = JSON.parse(raw) as Partial<CollaborationSettings>;
		const settings = { ...DEFAULT_COLLABORATION_SETTINGS };
		for (const key of Object.keys(settings) as Array<keyof CollaborationSettings>) {
			if (typeof saved[key] === typeof settings[key]) {
				(settings as Record<string, unknown>)[key] = saved[key];
			}
		}
		if (!["manual", "last_write_wins", "first_write_wins"].includes(settings.conflictStrategy)) {
			settings.conflictStrategy = "manual";
		}
		return settings;
	} catch {
		return { ...DEFAULT_COLLABORATION_SETTINGS };
	}
}

function saveSettings(settings: CollaborationSettings): void {
	try {
		globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// A full or blocked storage keeps the settings for this session only.
	}
}

interface CollaborationState {
	/** The server project whose room is joined, or "" when none. */
	projectId: string;
	live: boolean;
	me: TeamMember | null;
	users: TeamMember[];
	locks: Record<string, TeamLock>;
	messages: TeamChatMessage[];
	notices: CollaborationNotice[];
	settings: CollaborationSettings;
	chatOpen: boolean;
	unreadChatCount: number;
	replyingTo: TeamChatMessage | null;
	/** The last message this person could not send, and why. */
	sendError: string | null;

	join: (projectId: string) => Promise<void>;
	leave: () => void;
	applyUpdate: (update: TeamRoomUpdate) => void;
	sendMessage: (content: string) => Promise<boolean>;
	releaseLock: (taskId: string) => Promise<string | null>;
	setReplyingTo: (message: TeamChatMessage | null) => void;
	setChatOpen: (open: boolean) => void;
	toggleChat: () => void;
	takeNotices: () => CollaborationNotice[];
	updateSettings: (updates: Partial<CollaborationSettings>) => void;
}

let noticeSeq = 0;

const EMPTY_ROOM = {
	projectId: "",
	live: false,
	me: null,
	users: [],
	locks: {},
	messages: [],
	notices: [],
	chatOpen: false,
	unreadChatCount: 0,
	replyingTo: null,
	sendError: null,
} satisfies Partial<CollaborationState>;

export const useCollaborationStore = create<CollaborationState>((set, get) => ({
	...EMPTY_ROOM,
	settings: loadSettings(),

	join: async (projectId) => {
		if (get().projectId === projectId) return;
		const previous = get().projectId;
		if (previous) void globalThis.electronAPI?.leaveTeamRoom?.(previous);
		set({ ...EMPTY_ROOM, projectId });
		const result = await globalThis.electronAPI?.joinTeamRoom?.(projectId);
		if (!result?.success && get().projectId === projectId) set({ projectId: "" });
	},

	leave: () => {
		const { projectId } = get();
		if (projectId) void globalThis.electronAPI?.leaveTeamRoom?.(projectId);
		set({ ...EMPTY_ROOM });
	},

	applyUpdate: (update) => {
		const state = get();
		if (!state.projectId || update.projectId !== state.projectId) return;
		const notice = (n: NoticeBody) =>
			[...state.notices, { ...n, seq: ++noticeSeq } as CollaborationNotice].slice(
				-MAX_ACTIVITIES,
			);
		switch (update.kind) {
			case "state":
				set({
					live: update.live,
					me: update.me,
					users: update.users,
					locks: Object.fromEntries(update.locks.map((lock) => [lock.taskId, lock])),
				});
				return;
			case "chat": {
				const known = update.replace ? new Set<string>() : new Set(state.messages.map((m) => m.id));
				const fresh = update.messages.filter((m) => !known.has(m.id));
				const base = update.replace ? [] : state.messages;
				const messages = [...base, ...fresh].slice(-MAX_MESSAGES);
				// History is what was said before: only new messages count as unread.
				const incoming = update.replace
					? []
					: fresh.filter((m) => m.authorId !== state.me?.id);
				let notices = state.notices;
				for (const m of incoming) {
					if (mentions(m.message, state.me)) {
						notices = [
							...notices,
							{ seq: ++noticeSeq, kind: "mention" as const, author: m.author, message: m.message },
						].slice(-MAX_ACTIVITIES);
					}
				}
				set({
					messages,
					notices,
					unreadChatCount: state.chatOpen
						? 0
						: state.unreadChatCount + incoming.length,
				});
				return;
			}
			case "rejected":
				set({
					sendError: update.reason,
					notices: notice({ kind: "rejected", reason: update.reason }),
				});
				return;
			case "activity":
				set({ notices: notice({ kind: "activity", activity: update.activity }) });
				return;
		}
	},

	sendMessage: async (content) => {
		const { projectId, replyingTo } = get();
		const text = content.trim();
		if (!projectId || !text) return false;
		const result = await globalThis.electronAPI?.sendTeamChat?.(
			projectId,
			text,
			replyingTo?.id ?? "",
		);
		if (result?.success) {
			set({ replyingTo: null, sendError: null });
			return true;
		}
		set({ sendError: result?.error ?? "offline" });
		return false;
	},

	releaseLock: async (taskId) => {
		const result = await globalThis.electronAPI?.releaseCardClaim?.(taskId);
		return result?.success ? null : (result?.error ?? "unavailable");
	},

	setReplyingTo: (message) => set({ replyingTo: message }),

	setChatOpen: (open) =>
		set((state) => ({ chatOpen: open, unreadChatCount: open ? 0 : state.unreadChatCount })),

	toggleChat: () => get().setChatOpen(!get().chatOpen),

	takeNotices: () => {
		const { notices } = get();
		if (notices.length > 0) set({ notices: [] });
		return notices;
	},

	updateSettings: (updates) => {
		const settings = { ...get().settings, ...updates };
		saveSettings(settings);
		set({ settings });
	},
}));

/** Follow the team room's updates from the main process; returns the cleanup. */
export function setupCollaborationListeners(): () => void {
	const off = globalThis.electronAPI?.onTeamRoomUpdate?.((update) =>
		useCollaborationStore.getState().applyUpdate(update),
	);
	return off ?? (() => undefined);
}
