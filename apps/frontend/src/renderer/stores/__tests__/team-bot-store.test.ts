/**
 * @vitest-environment jsdom
 *
 * The renderer no longer keeps the Team Bot webhook URL (F175): it reads the
 * configuration from the main process, saves each edit there, and moves what
 * an earlier version left in localStorage over once, then deletes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_STORAGE_KEY, useTeamBotStore } from "../team-bot-store";

const MASK = "••••••••";
const URL = "https://hooks.slack.com/services/T/B/secret";

const api = {
	teamBotGetConfig: vi.fn(async () => ({ kind: "slack", webhook_url: MASK })),
	teamBotSaveConfig: vi.fn(async (config: { kind: string }) => ({
		...config,
		webhook_url: MASK,
	})),
	teamBotSend: vi.fn(async () => ({ ok: true })),
	teamBotTest: vi.fn(async () => ({ ok: true })),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	localStorage.clear();
	useTeamBotStore.setState({ config: { kind: "slack", webhook_url: "" }, loaded: false });
});

describe("team-bot-store", () => {
	it("shows the configuration the main process keeps, URL masked", async () => {
		await useTeamBotStore.getState().load();
		expect(api.teamBotGetConfig).toHaveBeenCalledOnce();
		expect(useTeamBotStore.getState().config.webhook_url).toBe(MASK);
	});

	it("moves a URL left in localStorage to the main process and deletes it", async () => {
		localStorage.setItem(
			LEGACY_STORAGE_KEY,
			JSON.stringify({ state: { config: { kind: "teams", webhook_url: URL } }, version: 0 }),
		);
		await useTeamBotStore.getState().load();

		expect(api.teamBotSaveConfig).toHaveBeenCalledWith({ kind: "teams", webhook_url: URL });
		expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
		expect(useTeamBotStore.getState().config.webhook_url).toBe(MASK);
	});

	it("saves each edit, then tests and sends without naming a URL", async () => {
		useTeamBotStore.getState().setConfig({ enabled: true });
		await useTeamBotStore.getState().sendTest();
		expect(api.teamBotSaveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true }),
		);
		expect(api.teamBotTest).toHaveBeenCalledWith();
		expect(useTeamBotStore.getState().lastResult).toBe("ok");

		const payload = { event: "custom" as const, title: "T", summary: "S" };
		expect(await useTeamBotStore.getState().notify(payload)).toBe(true);
		expect(api.teamBotSend).toHaveBeenCalledWith(payload);
	});
});
