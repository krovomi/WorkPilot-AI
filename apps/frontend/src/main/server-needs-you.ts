/**
 * A server account's own "needs you" channels: ntfy, Telegram or a Teams
 * webhook, on which the server tells this person a card waits for them
 * (`apps/backend/server/services/needs_you.py`).
 *
 * The renderer is not trusted (S6): every argument is checked again here
 * against a closed list of channels, fields and moments, and a secret only
 * goes one way. The server returns a mask in place of each one, and what is
 * passed back to the renderer is rebuilt field by field from that answer.
 */

import {
	NEEDS_YOU_CHANNELS,
	NEEDS_YOU_EVENTS,
	NEEDS_YOU_MASK,
	type NeedsYouChannelKind,
	type ServerNeedsYouChannel,
	type ServerNeedsYouChannelInput,
	type ServerNeedsYouOverview,
	type ServerNeedsYouTestResult,
} from "../shared/types/server-needs-you";
import type { IPCResult } from "../shared/types";
import { authedFetch } from "./server-connection";

const BASE = "/users/me/needs-you";
const CHANNELS: ReadonlySet<string> = new Set(NEEDS_YOU_CHANNELS);
/** Each channel's text fields and their longest value, as the server takes them. */
const FIELDS: Record<NeedsYouChannelKind, Record<string, number>> = {
	ntfy: { server: 2_048, topic: 64, access_token: 256 },
	telegram: { bot_token: 128, chat_id: 24 },
	teams: { webhook_url: 2_048 },
};
const RESULTS: ReadonlySet<string> = new Set(["sent", "refused", "blocked", "unreachable"]);

function isChannel(channel: unknown): channel is NeedsYouChannelKind {
	return typeof channel === "string" && CHANNELS.has(channel);
}

/** The server's reason, or a plain one: never a long text that could quote input. */
function reason(error: unknown, fallback: string): string {
	return typeof error === "string" && error.length <= 300 ? error : fallback;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function shownChannel(raw: unknown): ServerNeedsYouChannel {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	if (value.configured !== true) return { configured: false };
	const shown: ServerNeedsYouChannel = {
		configured: true,
		enabled: value.enabled === true,
		readable: value.readable !== false,
	};
	for (const key of ["topic", "access_token", "bot_token", "webhook_url"] as const) {
		// Only ever "set" or not: whatever the server sent, the renderer gets the mask.
		if (key in value) shown[key] = value[key] ? NEEDS_YOU_MASK : null;
	}
	if (text(value.server) !== undefined) shown.server = text(value.server);
	if (text(value.chat_id) !== undefined) shown.chat_id = text(value.chat_id);
	return shown;
}

export async function getServerNeedsYou(): Promise<IPCResult<ServerNeedsYouOverview>> {
	const result = await authedFetch<Record<string, unknown>>(BASE, "GET");
	if (!result.ok) return { success: false, error: reason(result.error, "Server unavailable") };
	const data = result.data ?? {};
	const events = (data.events ?? {}) as Record<string, unknown>;
	const channels = (data.channels ?? {}) as Record<string, unknown>;
	return {
		success: true,
		data: {
			available: data.available === true,
			vault: data.vault === true,
			locale: data.locale === "fr" ? "fr" : "en",
			events: Object.fromEntries(
				NEEDS_YOU_EVENTS.map((event) => [event, events[event] !== false]),
			) as ServerNeedsYouOverview["events"],
			channels: Object.fromEntries(
				NEEDS_YOU_CHANNELS.map((channel) => [channel, shownChannel(channels[channel])]),
			) as ServerNeedsYouOverview["channels"],
		},
	};
}

export async function saveServerNeedsYouChannel(
	channel: unknown,
	input: unknown,
): Promise<IPCResult> {
	if (!isChannel(channel)) return { success: false, error: "Unknown channel" };
	const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const body: ServerNeedsYouChannelInput & Record<string, unknown> = {
		enabled: raw.enabled !== false,
	};
	for (const [field, max] of Object.entries(FIELDS[channel])) {
		const value = raw[field];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string" || value.length > max || /\s/.test(value.trim())) {
			return { success: false, error: "Invalid settings" };
		}
		body[field] = value.trim();
	}
	const result = await authedFetch(`${BASE}/channels/${channel}`, "PUT", body);
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "The server refused the settings") };
}

export async function deleteServerNeedsYouChannel(channel: unknown): Promise<IPCResult> {
	if (!isChannel(channel)) return { success: false, error: "Unknown channel" };
	const result = await authedFetch(`${BASE}/channels/${channel}`, "DELETE");
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "Server unavailable") };
}

export async function testServerNeedsYouChannel(
	channel: unknown,
): Promise<IPCResult<ServerNeedsYouTestResult>> {
	if (!isChannel(channel)) return { success: false, error: "Unknown channel" };
	const result = await authedFetch<{ result?: unknown }>(
		`${BASE}/channels/${channel}/test`,
		"POST",
	);
	if (!result.ok) return { success: false, error: reason(result.error, "Server unavailable") };
	const sent = result.data?.result;
	return {
		success: true,
		data: typeof sent === "string" && RESULTS.has(sent)
			? (sent as ServerNeedsYouTestResult)
			: "refused",
	};
}

export async function saveServerNeedsYouPreferences(prefs: unknown): Promise<IPCResult> {
	const raw = (prefs && typeof prefs === "object" ? prefs : {}) as Record<string, unknown>;
	const events = (raw.events && typeof raw.events === "object" ? raw.events : {}) as Record<
		string,
		unknown
	>;
	const body = {
		events: Object.fromEntries(
			NEEDS_YOU_EVENTS.map((event) => [event, events[event] !== false]),
		),
		locale: raw.locale === "fr" ? "fr" : "en",
	};
	const result = await authedFetch(`${BASE}/preferences`, "PUT", body);
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "Server unavailable") };
}
