import { describe, expect, it, vi } from "vitest";
import { ntfyTarget, sendNtfy, sendTelegram, TELEGRAM_API, telegramTarget } from "../channels";

const TOPIC = "workpilot-AbCdEfGhIjKlMnOpQrStUv";
const BOT = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjj";

describe("ntfyTarget", () => {
	it("defaults to ntfy.sh over https", () => {
		expect(ntfyTarget({ ntfy: { enabled: true, topic: TOPIC } })).toEqual({ url: `https://ntfy.sh/${TOPIC}` });
	});

	it("is off unless enabled with a valid topic", () => {
		expect(ntfyTarget({ ntfy: { enabled: false, topic: TOPIC } })).toBeNull();
		expect(ntfyTarget({ ntfy: { enabled: true, topic: "a/b" } })).toBeNull();
		expect(ntfyTarget(undefined)).toBeNull();
	});

	it("refuses a short topic on the public server, where the topic is the only secret", () => {
		expect(ntfyTarget({ ntfy: { enabled: true, topic: "workpilot" } })).toBeNull();
		expect(ntfyTarget({ ntfy: { enabled: true, topic: "workpilot", server: "https://ntfy.example.com" } })).not.toBeNull();
	});

	it("never sends a token in clear text over the network", () => {
		expect(ntfyTarget({ ntfy: { enabled: true, topic: TOPIC, server: "http://ntfy.example.com" } })).toBeNull();
		expect(ntfyTarget({ ntfy: { enabled: true, topic: TOPIC, server: "http://localhost:8080" } }, "tk")).toEqual({
			url: `http://localhost:8080/${TOPIC}`,
			token: "tk",
		});
		expect(ntfyTarget({ ntfy: { enabled: true, topic: TOPIC, server: "https://u:p@ntfy.example.com" } })).toBeNull();
		expect(ntfyTarget({ ntfy: { enabled: true, topic: TOPIC, server: "not a url" } })).toBeNull();
	});
});

describe("telegramTarget", () => {
	const on = (chatId: string) => ({ telegram: { enabled: true, chatId, remoteApproval: false } });

	it("needs a well-formed bot token and a numeric chat id", () => {
		expect(telegramTarget(on("42"), BOT)).toEqual({ botToken: BOT, chatId: "42" });
		expect(telegramTarget(on("42"), "nope")).toBeNull();
		expect(telegramTarget(on("@me"), BOT)).toBeNull();
		expect(telegramTarget(on("42"), undefined)).toBeNull();
		expect(telegramTarget({ telegram: { enabled: false, chatId: "42", remoteApproval: false } }, BOT)).toBeNull();
	});
});

describe("sendNtfy", () => {
	it("puts the UTF-8 title in the query, the token in a header, and refuses redirects", async () => {
		const fetch = vi.fn(async () => new Response("", { status: 200 }));
		const ok = await sendNtfy({ url: `https://ntfy.sh/${TOPIC}`, token: "tk" }, "Un plan t'attend", "body", fetch);
		expect(ok).toBe(true);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(new URL(url).searchParams.get("title")).toBe("Un plan t'attend");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
		expect(init.redirect).toBe("error");
		expect(init.body).toBe("body");
	});

	it("reports a refused publish", async () => {
		const fetch = vi.fn(async () => new Response("", { status: 403 }));
		expect(await sendNtfy({ url: `https://ntfy.sh/${TOPIC}` }, "t", "b", fetch)).toBe(false);
	});
});

describe("sendTelegram", () => {
	it("sends plain text, with a one-shot button only when asked", async () => {
		const fetch = vi.fn(async () => Response.json({ ok: true }));
		await sendTelegram({ botToken: BOT, chatId: "42" }, "Title", "Body", undefined, fetch);
		await sendTelegram({ botToken: BOT, chatId: "42" }, "Title", "Body", { token: "tok", label: "Approve" }, fetch);
		const [url, plain] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${TELEGRAM_API}/bot${BOT}/sendMessage`);
		const plainBody = JSON.parse(String(plain.body));
		expect(plainBody).toEqual({ chat_id: "42", text: "Title\nBody" });
		expect(plainBody.parse_mode).toBeUndefined();
		const withButton = JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body));
		expect(withButton.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Approve", callback_data: "approve:tok" });
	});

	it("reports Telegram's refusal", async () => {
		const fetch = vi.fn(async () => Response.json({ ok: false }));
		expect(await sendTelegram({ botToken: BOT, chatId: "42" }, "t", "b", undefined, fetch)).toBe(false);
	});
});
