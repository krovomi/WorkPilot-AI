/**
 * A person's own "needs you" channels on the server (`server/routers/needs_you.py`):
 * where the server tells them a card waits (ntfy, Telegram, Teams), and for
 * which moments. The server never sends a secret back, only `MASK` in its place.
 */

export const CHANNELS = ["ntfy", "telegram", "teams"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The moments the server can tell, in the order the settings list them. */
export const MOMENTS = ["plan_review", "review_ready", "failed", "approval_escalated", "review_feedback_held"] as const;
export type Moment = (typeof MOMENTS)[number];

/** What the server shows in place of a stored secret: that it is set, nothing of it. */
export const MASK = "********";

export type ChannelState =
	| { configured: false }
	| {
			configured: true;
			enabled: boolean;
			/** False when the server can no longer decrypt what it stored. */
			readable: boolean;
			server?: string;
			topic?: string | null;
			access_token?: string | null;
			bot_token?: string | null;
			chat_id?: string;
			webhook_url?: string | null;
	  };

/** `GET /users/me/needs-you`. */
export interface NeedsYouOverview {
	/** The operator turned sending on (`WORKPILOT_NEEDS_YOU_ENABLED`). */
	available: boolean;
	/** The server has its secrets key: a channel can be stored. */
	vault: boolean;
	locale: string;
	events: Partial<Record<Moment, boolean>>;
	channels: Partial<Record<Channel, ChannelState>>;
}

/** What `PUT .../channels/{channel}` takes; a secret left out keeps the stored one. */
export interface ChannelSettings {
	enabled: boolean;
	server?: string;
	topic?: string;
	access_token?: string;
	bot_token?: string;
	chat_id?: string;
	webhook_url?: string;
}

/** What a test answered: sent, or why not. */
export type TestResult = "sent" | "blocked" | "refused" | "unreachable";

/** The fields each channel asks for; `secret` ones are typed blind and never read back. */
export const CHANNEL_FIELDS: Record<Channel, readonly { key: keyof ChannelSettings; secret: boolean; optional?: boolean }[]> = {
	ntfy: [
		{ key: "server", secret: false, optional: true },
		{ key: "topic", secret: true },
		{ key: "access_token", secret: true, optional: true },
	],
	telegram: [
		{ key: "bot_token", secret: true },
		{ key: "chat_id", secret: false },
	],
	teams: [{ key: "webhook_url", secret: true }],
};
