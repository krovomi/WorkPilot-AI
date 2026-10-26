/**
 * Where a "needs you" goes besides the desktop: ntfy and Telegram.
 *
 * Both are reached outbound only. Nothing listens on the machine: a remote
 * approval comes back by WorkPilot polling Telegram (`telegram-poller.ts`),
 * so the app needs no open port and no tunnel. ntfy is notification only:
 * anyone who knows a topic can publish to it, so it cannot carry an answer.
 *
 * The settings are validated here, where they are used, not only in the
 * settings screen (S6): a token goes only to the host it belongs to.
 */
import type { NeedsYouSettings } from "../../shared/types";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_NTFY_HOST = "ntfy.sh";
export const PUBLIC_TOPIC_MIN = 16;
const TELEGRAM_BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,64}$/;
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;
export const TELEGRAM_API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

export interface NtfyTarget {
	url: string;
	token?: string;
}

/** The ntfy publish URL, or null when the settings do not name a safe one. */
export function ntfyTarget(settings: NeedsYouSettings | undefined, token?: string): NtfyTarget | null {
	const ntfy = settings?.ntfy;
	if (!ntfy?.enabled || !NTFY_TOPIC.test(ntfy.topic ?? "")) return null;
	let server: URL;
	try {
		server = new URL(ntfy.server?.trim() || "https://ntfy.sh");
	} catch {
		return null;
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname);
	// A token in clear text over the network is a token given away.
	if (server.protocol !== "https:" && !(server.protocol === "http:" && loopback)) return null;
	if (server.username || server.password) return null;
	// On the public server the topic is the only secret: whoever guesses it
	// reads the task titles. A short one is refused, not sent.
	if (server.hostname === PUBLIC_NTFY_HOST && ntfy.topic.length < PUBLIC_TOPIC_MIN) return null;
	const base = server.toString().replace(/\/+$/, "");
	return { url: `${base}/${ntfy.topic}`, ...(token && { token }) };
}

export interface TelegramTarget {
	botToken: string;
	chatId: string;
}

export function telegramTarget(
	settings: NeedsYouSettings | undefined,
	botToken: string | undefined,
): TelegramTarget | null {
	const telegram = settings?.telegram;
	if (!telegram?.enabled || !botToken || !TELEGRAM_BOT_TOKEN.test(botToken)) return null;
	const chatId = String(telegram.chatId ?? "").trim();
	if (!TELEGRAM_CHAT_ID.test(chatId)) return null;
	return { botToken, chatId };
}

function withTimeout(init: RequestInit): RequestInit {
	return { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) };
}

export async function sendNtfy(
	target: NtfyTarget,
	title: string,
	body: string,
	doFetch: Fetch = fetch,
): Promise<boolean> {
	// The title as a query parameter: a header cannot carry "Un plan t'attend"'s
	// UTF-8, and ntfy reads both.
	const url = new URL(target.url);
	url.searchParams.set("title", title.slice(0, 200));
	url.searchParams.set("tags", "robot");
	url.searchParams.set("priority", "high");
	const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
	if (target.token) headers.Authorization = `Bearer ${target.token}`;
	const response = await doFetch(
		url.toString(),
		withTimeout({ method: "POST", headers, body, redirect: "error" }),
	);
	return response.ok;
}

export async function telegramCall(
	target: TelegramTarget,
	method: string,
	payload: Record<string, unknown>,
	doFetch: Fetch = fetch,
	timeoutMs = TIMEOUT_MS,
): Promise<{ ok: boolean; result?: unknown }> {
	const response = await doFetch(`${TELEGRAM_API}/bot${target.botToken}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
	});
	try {
		return (await response.json()) as { ok: boolean; result?: unknown };
	} catch {
		return { ok: false };
	}
}

export async function sendTelegram(
	target: TelegramTarget,
	title: string,
	body: string,
	approval?: { token: string; label: string },
	doFetch: Fetch = fetch,
): Promise<boolean> {
	const result = await telegramCall(
		target,
		"sendMessage",
		{
			chat_id: target.chatId,
			// Plain text: a task title is the user's text, not markup.
			text: `${title}\n${body}`,
			...(approval && {
				reply_markup: {
					inline_keyboard: [[{ text: approval.label, callback_data: `approve:${approval.token}` }]],
				},
			}),
		},
		doFetch,
	);
	return result.ok;
}
