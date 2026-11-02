/**
 * A server account's "needs you" channels: a closed list of channels and
 * fields checked again in main, a secret that never comes back to the
 * renderer whatever the server sends, and a refusal never quoted at length.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../server-connection", () => ({ authedFetch: mocks.authedFetch }));

import {
	deleteServerNeedsYouChannel,
	getServerNeedsYou,
	saveServerNeedsYouChannel,
	saveServerNeedsYouPreferences,
	testServerNeedsYouChannel,
} from "../server-needs-you";

const BOT = `123:${"x".repeat(24)}`;

beforeEach(() => mocks.authedFetch.mockReset());

describe("server needs-you channels", () => {
	it("passes only masks to the renderer, whatever the server returns", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: {
				available: true,
				vault: true,
				locale: "fr",
				events: { plan_review: false, other: true },
				channels: {
					telegram: {
						configured: true,
						enabled: true,
						bot_token: BOT,
						chat_id: "42",
						extra: "leak",
					},
					teams: { configured: false },
					slack: { configured: true },
				},
			},
		});
		const result = await getServerNeedsYou();
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/needs-you", "GET");
		expect(result.success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(BOT);
		expect(JSON.stringify(result)).not.toContain("leak");
		expect(result.data?.channels.telegram).toEqual({
			configured: true,
			enabled: true,
			readable: true,
			bot_token: "********",
			chat_id: "42",
		});
		expect(result.data?.channels.ntfy).toEqual({ configured: false });
		expect(Object.keys(result.data?.channels ?? {})).toEqual(["ntfy", "telegram", "teams"]);
		expect(result.data?.events).toEqual({
			plan_review: false,
			review_ready: true,
			failed: true,
		});
		expect(result.data?.locale).toBe("fr");
	});

	it("sends a channel's own fields only, trimmed", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { saved: true } });
		expect(
			await saveServerNeedsYouChannel("telegram", {
				enabled: false,
				bot_token: ` ${BOT} `,
				chat_id: "42",
				webhook_url: "https://elsewhere.example",
			}),
		).toEqual({ success: true });
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/users/me/needs-you/channels/telegram",
			"PUT",
			{ enabled: false, bot_token: BOT, chat_id: "42" },
		);
	});

	it("refuses an unknown channel or a malformed field without asking the server", async () => {
		for (const [channel, input] of [
			["slack", {}],
			["../secrets", {}],
			["teams", { webhook_url: 42 }],
			["teams", { webhook_url: "https://a.example/x y" }],
			["teams", { webhook_url: `https://${"a".repeat(2_049)}` }],
			["ntfy", { topic: "x".repeat(65) }],
		] as const) {
			expect((await saveServerNeedsYouChannel(channel, input)).success).toBe(false);
		}
		expect((await deleteServerNeedsYouChannel("../users")).success).toBe(false);
		expect((await testServerNeedsYouChannel(1)).success).toBe(false);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("tests and deletes on the channel's own route", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { result: "sent" } });
		expect(await testServerNeedsYouChannel("ntfy")).toEqual({ success: true, data: "sent" });
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/users/me/needs-you/channels/ntfy/test",
			"POST",
		);
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { result: "<script>" } });
		expect(await testServerNeedsYouChannel("ntfy")).toEqual({
			success: true,
			data: "refused",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { deleted: true } });
		expect(await deleteServerNeedsYouChannel("teams")).toEqual({ success: true });
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/users/me/needs-you/channels/teams",
			"DELETE",
		);
	});

	it("sends the moments and the language from closed lists", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { saved: true } });
		await saveServerNeedsYouPreferences({
			events: { failed: false, merged: true },
			locale: "de",
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/needs-you/preferences", "PUT", {
			events: { plan_review: true, review_ready: true, failed: false },
			locale: "en",
		});
	});

	it("never relays a long refusal", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: false, error: "x".repeat(400) });
		expect(await saveServerNeedsYouChannel("teams", {})).toEqual({
			success: false,
			error: "The server refused the settings",
		});
	});
});
