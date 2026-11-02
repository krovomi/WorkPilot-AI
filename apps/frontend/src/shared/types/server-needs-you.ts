/**
 * A server account's own "needs you" channels (server mode): what the server
 * says is set, and what the settings screen sends. A secret comes back only
 * as `NEEDS_YOU_MASK`; sending the mask (or nothing) keeps the stored one.
 * See `apps/backend/server/services/needs_you.py`.
 */

export const NEEDS_YOU_CHANNELS = ["ntfy", "telegram", "teams"] as const;
export type NeedsYouChannelKind = (typeof NEEDS_YOU_CHANNELS)[number];

export const NEEDS_YOU_EVENTS = ["plan_review", "review_ready", "failed"] as const;
export type NeedsYouEventKind = (typeof NEEDS_YOU_EVENTS)[number];

export const NEEDS_YOU_MASK = "********";

export interface ServerNeedsYouChannel {
	configured: boolean;
	enabled?: boolean;
	/** False when the server can no longer decrypt it (its key changed). */
	readable?: boolean;
	server?: string;
	chat_id?: string;
	topic?: string | null;
	access_token?: string | null;
	bot_token?: string | null;
	webhook_url?: string | null;
}

export interface ServerNeedsYouOverview {
	/** The operator turned sending on (`WORKPILOT_NEEDS_YOU_ENABLED`). */
	available: boolean;
	/** The server has a master key to store secrets with. */
	vault: boolean;
	locale: "en" | "fr";
	events: Record<NeedsYouEventKind, boolean>;
	channels: Record<NeedsYouChannelKind, ServerNeedsYouChannel>;
}

export interface ServerNeedsYouChannelInput {
	enabled: boolean;
	server?: string;
	topic?: string;
	access_token?: string;
	bot_token?: string;
	chat_id?: string;
	webhook_url?: string;
}

export type ServerNeedsYouTestResult = "sent" | "refused" | "blocked" | "unreachable";
